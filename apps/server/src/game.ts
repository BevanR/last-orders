import {
  advanceAct,
  autoAdvance,
  discover,
  findSuspect,
  initialSuspectStates,
  present,
  redact,
  share,
  start,
  type CaseFile,
  type GameState,
  type GameView,
} from '@last-orders/engine';
import { hashToken, newRoomCode, newToken, type Session } from './auth.js';
import type { CaseStore } from './cases.js';
import { withTx, type Db, type Tx } from './db.js';
import { HttpError } from './errors.js';
import { emit } from './events.js';
import type { JobQueue } from './jobs.js';
import {
  ensureInterview,
  findGameByCode,
  loadState,
  lockGame,
  toMessageDto,
  type GameRow,
  type MessageDto,
  type MessageRow,
} from './store.js';

const MAX_PLAYERS = 8;
const MAX_PENDING_JOBS_PER_PLAYER = 2;

export interface InterviewDto {
  suspectId: string;
  messages: MessageDto[];
  /** True while a reply is being written. */
  waiting: boolean;
}

/** Player and host actions. Each runs in one transaction under the game row lock. */
export class GameService {
  constructor(
    private readonly db: Db,
    private readonly cases: CaseStore,
    private readonly jobs: JobQueue,
    /** Called after a transaction that enqueued model work commits. */
    private readonly onWork: () => void,
  ) {}

  private async inGame<T>(
    gameId: string,
    fn: (tx: Tx, game: GameRow, c: CaseFile, s: GameState) => Promise<T>,
  ): Promise<T> {
    return withTx(this.db, async (tx) => {
      const game = await lockGame(tx, gameId);
      const c = await this.cases.get(game.case_version_id);
      const s = await loadState(tx, game);
      return fn(tx, game, c, s);
    });
  }

  async createRoom(displayName: string): Promise<{ roomCode: string; hostToken: string; sessionToken: string }> {
    const c = await this.cases.get(this.cases.currentVersionId);
    const hostToken = newToken();
    const sessionToken = newToken();
    for (let attempt = 0; attempt < 5; attempt++) {
      const roomCode = newRoomCode();
      try {
        await withTx(this.db, async (tx) => {
          const { rows } = await tx.query<{ id: string }>(
            `INSERT INTO games (room_code, host_token_hash, case_version_id) VALUES ($1, $2, $3) RETURNING id`,
            [roomCode, hashToken(hostToken), this.cases.currentVersionId],
          );
          const gameId = rows[0]!.id;
          for (const [suspectId, state] of Object.entries(initialSuspectStates(c)))
            await tx.query('INSERT INTO suspect_states (game_id, suspect_id, state) VALUES ($1, $2, $3)', [
              gameId,
              suspectId,
              state,
            ]);
          const p = await tx.query<{ id: string }>(
            `INSERT INTO players (game_id, display_name, session_token_hash, is_host)
             VALUES ($1, $2, $3, true) RETURNING id`,
            [gameId, displayName, hashToken(sessionToken)],
          );
          await emit(tx, gameId, 'public', 'player_joined', {
            player: { id: p.rows[0]!.id, name: displayName, isHost: true },
          });
        });
        return { roomCode, hostToken, sessionToken };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') continue; // room code collision
        throw err;
      }
    }
    throw new HttpError(503, 'no_room_code', 'Could not allocate a room code. Try again.');
  }

  async join(roomCode: string, displayName: string): Promise<{ sessionToken: string }> {
    const game = await findGameByCode(this.db, roomCode);
    const sessionToken = newToken();
    await this.inGame(game.id, async (tx, g, _c, s) => {
      if (g.status === 'ended') throw new HttpError(409, 'game_over', 'This game has ended.');
      if (s.players.length >= MAX_PLAYERS) throw new HttpError(409, 'room_full', 'This room is full.');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO players (game_id, display_name, session_token_hash) VALUES ($1, $2, $3) RETURNING id`,
        [g.id, displayName, hashToken(sessionToken)],
      );
      await emit(tx, g.id, 'public', 'player_joined', {
        player: { id: rows[0]!.id, name: displayName, isHost: false },
      });
    });
    return { sessionToken };
  }

  /** Exchange a host link token for a fresh host session. */
  async claimHost(hostToken: string): Promise<{ roomCode: string; sessionToken: string }> {
    const sessionToken = newToken();
    const { rows } = await this.db.query<{ room_code: string }>(
      `UPDATE players p SET session_token_hash = $2
         FROM games g
        WHERE g.host_token_hash = $1 AND p.game_id = g.id AND p.is_host
        RETURNING g.room_code`,
      [hashToken(hostToken), hashToken(sessionToken)],
    );
    if (!rows[0]) throw new HttpError(404, 'host_link_invalid', 'That host link is not valid.');
    return { roomCode: rows[0].room_code, sessionToken };
  }

  async view(session: Session): Promise<GameView> {
    const game = await findGameByCode(this.db, session.roomCode);
    const c = await this.cases.get(game.case_version_id);
    const s = await loadState(this.db, game);
    return redact(
      c,
      s,
      session.isHost ? { kind: 'host', playerId: session.playerId } : { kind: 'player', playerId: session.playerId },
    );
  }

  async start(session: Session): Promise<void> {
    await this.inGame(session.gameId, async (tx, g, c, s) => {
      const { act } = start(s);
      await tx.query(
        "UPDATE games SET status = 'active', act = $2, revision = revision + 1, last_progress_at = now() WHERE id = $1",
        [g.id, act],
      );
      const a = c.acts[act - 1]!;
      await emit(tx, g.id, 'public', 'game_started', { act: { number: a.number, name: a.name } });
    });
  }

  async advance(session: Session): Promise<void> {
    await this.inGame(session.gameId, async (tx, g, c, s) => {
      const { act } = advanceAct(c, s);
      await this.setAct(tx, g, c, act);
    });
  }

  private async setAct(tx: Tx, g: GameRow, c: CaseFile, act: number) {
    await tx.query('UPDATE games SET act = $2, revision = revision + 1 WHERE id = $1', [g.id, act]);
    const a = c.acts[act - 1]!;
    await emit(tx, g.id, 'public', 'act_changed', { act: { number: a.number, name: a.name } });
  }

  /** After a state change inside a transaction, move to the next act if its condition holds. */
  private async maybeAutoAdvance(tx: Tx, g: GameRow, c: CaseFile, s: GameState) {
    const next = autoAdvance(c, s);
    if (next !== null) await this.setAct(tx, g, c, next);
  }

  async inspect(session: Session, locationId: string) {
    return this.inGame(session.gameId, async (tx, g, c, s) => {
      const { location, found } = discover(c, s, session.playerId, locationId);
      await tx.query(
        `INSERT INTO location_visits (game_id, location_id, player_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [g.id, locationId, session.playerId],
      );
      s.visits.push({ locationId, playerId: session.playerId });
      for (const e of found) {
        await tx.query(
          `INSERT INTO evidence_discoveries (game_id, evidence_id, player_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [g.id, e.id, session.playerId],
        );
        s.discoveries.push({ evidenceId: e.id, playerId: session.playerId });
      }
      const result = {
        locationId,
        text: location.inspect_text,
        found: found.map((e) => ({ id: e.id, name: e.name, description: e.description, text: e.found_text })),
      };
      if (found.length) {
        await tx.query('UPDATE games SET revision = revision + 1, last_progress_at = now() WHERE id = $1', [g.id]);
        await emit(tx, g.id, `player:${session.playerId}`, 'discovered', result);
        await this.maybeAutoAdvance(tx, g, c, s);
      }
      return result;
    });
  }

  async share(session: Session, evidenceId: string) {
    return this.inGame(session.gameId, async (tx, g, c, s) => {
      const { evidence, alreadyOnBoard } = share(c, s, session.playerId, evidenceId);
      await tx.query(
        'UPDATE evidence_discoveries SET shared_at = now() WHERE game_id = $1 AND evidence_id = $2 AND player_id = $3',
        [g.id, evidenceId, session.playerId],
      );
      if (!alreadyOnBoard) {
        await tx.query(`INSERT INTO board_items (game_id, evidence_id, shared_by) VALUES ($1, $2, $3)`, [
          g.id,
          evidenceId,
          session.playerId,
        ]);
        s.board.push({ evidenceId, sharedBy: session.playerId });
        await tx.query('UPDATE games SET revision = revision + 1, last_progress_at = now() WHERE id = $1', [g.id]);
        await emit(tx, g.id, 'public', 'board_item', {
          evidence: { id: evidence.id, name: evidence.name, description: evidence.description },
          sharedBy: session.displayName,
        });
        await this.maybeAutoAdvance(tx, g, c, s);
      }
      return { evidenceId, alreadyOnBoard };
    });
  }

  async interview(session: Session, suspectId: string): Promise<InterviewDto> {
    const game = await findGameByCode(this.db, session.roomCode);
    findSuspect(await this.cases.get(game.case_version_id), suspectId);
    const { rows } = await this.db.query<MessageRow>(
      `SELECT m.* FROM messages m JOIN interviews i ON i.id = m.interview_id
        WHERE i.game_id = $1 AND i.player_id = $2 AND i.suspect_id = $3
        ORDER BY m.id`,
      [session.gameId, session.playerId, suspectId],
    );
    const waiting = await this.db.query(
      `SELECT 1 FROM jobs j JOIN interviews i ON i.id = (j.payload->>'interviewId')::uuid
        WHERE j.game_id = $1 AND j.player_id = $2 AND i.suspect_id = $3 AND j.status IN ('pending', 'running')
        LIMIT 1`,
      [session.gameId, session.playerId, suspectId],
    );
    return { suspectId, messages: rows.map(toMessageDto), waiting: (waiting.rowCount ?? 0) > 0 };
  }

  /** Common checks before a player message or presentation is queued for a reply. */
  private async prepareTurn(tx: Tx, g: GameRow, session: Session, suspectId: string) {
    if (g.status !== 'active') throw new HttpError(409, 'game_not_active', 'The game is not in progress.');
    const interviewId = await ensureInterview(tx, g.id, session.playerId, suspectId);
    const { rows } = await tx.query<{ interview_id: string }>(
      `SELECT payload->>'interviewId' AS interview_id FROM jobs
        WHERE game_id = $1 AND player_id = $2 AND status IN ('pending', 'running')`,
      [g.id, session.playerId],
    );
    if (rows.some((r) => r.interview_id === interviewId))
      throw new HttpError(409, 'awaiting_reply', 'Wait for an answer first.');
    if (rows.length >= MAX_PENDING_JOBS_PER_PLAYER)
      throw new HttpError(429, 'too_many_pending', 'Wait for an answer first.');
    return interviewId;
  }

  async sendMessage(session: Session, suspectId: string, text: string): Promise<MessageDto> {
    const dto = await this.inGame(session.gameId, async (tx, g, c) => {
      findSuspect(c, suspectId);
      const interviewId = await this.prepareTurn(tx, g, session, suspectId);
      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO messages (interview_id, role, text) VALUES ($1, 'player', $2) RETURNING *`,
        [interviewId, text],
      );
      const message = rows[0]!;
      await this.jobs.enqueueSuspectReply(tx, g.id, session.playerId, {
        interviewId,
        suspectId,
        triggerMessageId: String(message.id),
        transitionId: null,
      });
      const out = toMessageDto(message);
      await emit(tx, g.id, `player:${session.playerId}`, 'message', { suspectId, message: out });
      return out;
    });
    this.onWork();
    return dto;
  }

  /**
   * Show evidence to a suspect. The engine decides whether an authored transition fires; the
   * game row lock plus the unique (game, suspect, transition) row make it fire at most once.
   */
  async present(session: Session, suspectId: string, evidenceId: string): Promise<MessageDto> {
    const dto = await this.inGame(session.gameId, async (tx, g, c, s) => {
      const r = present(c, s, session.playerId, suspectId, evidenceId);
      const interviewId = await this.prepareTurn(tx, g, session, suspectId);
      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO messages (interview_id, role, text, presented_evidence_id)
         VALUES ($1, 'player', $2, $3) RETURNING *`,
        [interviewId, `You show ${r.suspect.name} the ${r.evidence.name.toLowerCase()}.`, evidenceId],
      );
      const message = rows[0]!;
      let firedId: string | null = null;
      if (r.transition) {
        const t = r.transition;
        const fired = await tx.query(
          `INSERT INTO testimony_transitions
             (game_id, suspect_id, transition_id, from_state, to_state, evidence_id, fired_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (game_id, suspect_id, transition_id) DO NOTHING`,
          [g.id, suspectId, t.id, t.from_state, t.to_state, evidenceId, session.playerId],
        );
        if (fired.rowCount === 1) {
          await tx.query(
            `UPDATE suspect_states SET state = $3, revision = revision + 1
              WHERE game_id = $1 AND suspect_id = $2`,
            [g.id, suspectId, t.to_state],
          );
          await tx.query('UPDATE games SET revision = revision + 1, last_progress_at = now() WHERE id = $1', [g.id]);
          s.suspectStates[suspectId] = t.to_state;
          s.firedTransitions.push(t.id);
          firedId = t.id;
          for (const e of r.revealed) {
            await tx.query(
              `INSERT INTO evidence_discoveries (game_id, evidence_id, player_id) VALUES ($1, $2, $3)
               ON CONFLICT DO NOTHING`,
              [g.id, e.id, session.playerId],
            );
            s.discoveries.push({ evidenceId: e.id, playerId: session.playerId });
          }
        }
      }
      await this.jobs.enqueueSuspectReply(tx, g.id, session.playerId, {
        interviewId,
        suspectId,
        triggerMessageId: String(message.id),
        transitionId: firedId,
      });
      const out = toMessageDto(message);
      await emit(tx, g.id, `player:${session.playerId}`, 'message', { suspectId, message: out });
      if (firedId && r.revealed.length) {
        await emit(tx, g.id, `player:${session.playerId}`, 'discovered', {
          locationId: null,
          text: `${r.suspect.name} hands something over.`,
          found: r.revealed.map((e) => ({ id: e.id, name: e.name, description: e.description, text: e.found_text })),
        });
      }
      if (firedId) await this.maybeAutoAdvance(tx, g, c, s);
      return out;
    });
    this.onWork();
    return dto;
  }
}
