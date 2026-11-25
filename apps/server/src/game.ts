import {
  accuse,
  advanceAct,
  autoAdvance,
  discover,
  endGame,
  findSuspect,
  hintText,
  initialSuspectStates,
  nextHint,
  present,
  redact,
  RuleError,
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
import { applyIntervention } from './interventions.js';
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

export interface GameTiming {
  /** How often the game master looks at an active game. 0 disables it. */
  gmTickMs: number;
  /** No game-master ticks once no player has acted for this long. */
  idleMs: number;
}

export type ViewDto = GameView & {
  cursor: number;
  /** Model commentary on the reveal, once written. Only after the game has ended. */
  commentary?: { text: string; simulated: boolean } | null;
};

/** Player and host actions. Each runs in one transaction under the game row lock. */
export class GameService {
  constructor(
    private readonly db: Db,
    private readonly cases: CaseStore,
    private readonly jobs: JobQueue,
    /** Called after a transaction that enqueued model work commits. */
    private readonly onWork: () => void,
    private readonly timing: GameTiming = { gmTickMs: 90_000, idleMs: 20 * 60_000 },
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

  /** A player did something: the game is not idle. */
  private async touch(tx: Tx, gameId: string, progress = false) {
    await tx.query(
      `UPDATE games SET revision = revision + 1, last_activity_at = now()
              ${progress ? ', last_progress_at = now()' : ''}
        WHERE id = $1`,
      [gameId],
    );
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
          for (const [suspectId, threads] of Object.entries(initialSuspectStates(c)))
            for (const [threadId, state] of Object.entries(threads))
              await tx.query(
                'INSERT INTO suspect_states (game_id, suspect_id, thread_id, state) VALUES ($1, $2, $3, $4)',
                [gameId, suspectId, threadId, state],
              );
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

  /** The redacted view plus `cursor`, the event seq to resume the SSE stream from. */
  async view(session: Session): Promise<ViewDto> {
    const game = await findGameByCode(this.db, session.roomCode);
    const c = await this.cases.get(game.case_version_id);
    const s = await loadState(this.db, game);
    const audience = session.isHost
      ? ({ kind: 'host', playerId: session.playerId } as const)
      : ({ kind: 'player', playerId: session.playerId } as const);
    const out: ViewDto = { ...redact(c, s, audience), cursor: Number(game.event_seq) };
    if (game.status === 'ended')
      out.commentary = game.commentary ? { text: game.commentary, simulated: game.commentary_simulated } : null;
    return out;
  }

  async start(session: Session): Promise<void> {
    await this.inGame(session.gameId, async (tx, g, c, s) => {
      const { act } = start(s);
      await tx.query(
        `UPDATE games SET status = 'active', act = $2, revision = revision + 1, last_progress_at = now(),
                last_activity_at = now(), last_gm_tick_at = now(),
                act_started_at = jsonb_build_object($3::text, now())
          WHERE id = $1`,
        [g.id, act, String(act)],
      );
      const a = c.acts[act - 1]!;
      await emit(tx, g.id, 'public', 'game_started', { act: { number: a.number, name: a.name, intro: a.intro } });
    });
  }

  async advance(session: Session): Promise<void> {
    await this.inGame(session.gameId, async (tx, g, c, s) => {
      const { act } = advanceAct(c, s);
      await this.setAct(tx, g, c, s, act, 'host');
    });
  }

  private async setAct(tx: Tx, g: GameRow, c: CaseFile, s: GameState, act: number, by: 'host' | 'auto') {
    await tx.query(
      `UPDATE games SET act = $2, revision = revision + 1,
              act_started_at = act_started_at || jsonb_build_object($3::text, now())
        WHERE id = $1`,
      [g.id, act, String(act)],
    );
    s.act = act;
    s.actStartedAt[act] = s.now;
    const a = c.acts[act - 1]!;
    await emit(tx, g.id, 'public', 'act_changed', { act: { number: a.number, name: a.name, intro: a.intro }, by });
  }

  /** After a state change inside a transaction, move on while the current act's condition holds. */
  private async maybeAutoAdvance(tx: Tx, g: GameRow, c: CaseFile, s: GameState): Promise<boolean> {
    let moved = false;
    for (let next = autoAdvance(c, s); next !== null; next = autoAdvance(c, s)) {
      await this.setAct(tx, g, c, s, next, 'auto');
      moved = true;
    }
    return moved;
  }

  async inspect(session: Session, locationId: string, actionId: string) {
    return this.inGame(session.gameId, async (tx, g, c, s) => {
      const { location, action, found } = discover(c, s, session.playerId, locationId, actionId);
      await tx.query(
        `INSERT INTO location_visits (game_id, location_id, action_id, player_id) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [g.id, locationId, actionId, session.playerId],
      );
      s.visits.push({ locationId, actionId, playerId: session.playerId });
      for (const e of found) {
        await tx.query(
          `INSERT INTO evidence_discoveries (game_id, evidence_id, player_id) VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [g.id, e.id, session.playerId],
        );
        s.discoveries.push({ evidenceId: e.id, playerId: session.playerId });
      }
      const result = {
        locationId: location.id,
        actionId: action.id,
        text: action.text,
        found: found.map((e) => ({ id: e.id, name: e.name, description: e.description, text: e.found_text })),
      };
      await this.touch(tx, g.id, found.length > 0);
      if (found.length) {
        s.lastProgressAt = s.now;
        await emit(tx, g.id, `player:${session.playerId}`, 'discovered', result);
      }
      await this.maybeAutoAdvance(tx, g, c, s);
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
        await this.touch(tx, g.id, true);
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
        WHERE j.game_id = $1 AND j.player_id = $2 AND j.kind = 'suspect_reply' AND i.suspect_id = $3
          AND j.status IN ('pending', 'running')
        LIMIT 1`,
      [session.gameId, session.playerId, suspectId],
    );
    return { suspectId, messages: rows.map(toMessageDto), waiting: (waiting.rowCount ?? 0) > 0 };
  }

  /** Common checks before a player message or presentation is queued for a reply. */
  private async prepareTurn(tx: Tx, g: GameRow, s: GameState, session: Session, suspectId: string) {
    if (g.status !== 'active') throw new HttpError(409, 'game_not_active', 'The game is not in progress.');
    if (s.accusation)
      throw new HttpError(409, 'accusation_submitted', 'The accusation is in. Wait for the host to end it.');
    const interviewId = await ensureInterview(tx, g.id, session.playerId, suspectId);
    const { rows } = await tx.query<{ interview_id: string }>(
      `SELECT payload->>'interviewId' AS interview_id FROM jobs
        WHERE game_id = $1 AND player_id = $2 AND kind = 'suspect_reply' AND status IN ('pending', 'running')`,
      [g.id, session.playerId],
    );
    if (rows.some((r) => r.interview_id === interviewId))
      throw new HttpError(409, 'awaiting_reply', 'Wait for an answer first.');
    if (rows.length >= MAX_PENDING_JOBS_PER_PLAYER)
      throw new HttpError(429, 'too_many_pending', 'Wait for an answer first.');
    if (!s.interviewed.includes(suspectId)) s.interviewed.push(suspectId);
    return interviewId;
  }

  async sendMessage(session: Session, suspectId: string, text: string): Promise<MessageDto> {
    const dto = await this.inGame(session.gameId, async (tx, g, c, s) => {
      findSuspect(c, suspectId);
      const interviewId = await this.prepareTurn(tx, g, s, session, suspectId);
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
        reaction: null,
      });
      await this.touch(tx, g.id);
      const out = toMessageDto(message);
      await emit(tx, g.id, `player:${session.playerId}`, 'message', { suspectId, message: out });
      await this.maybeAutoAdvance(tx, g, c, s);
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
      const interviewId = await this.prepareTurn(tx, g, s, session, suspectId);
      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO messages (interview_id, role, text, presented_evidence_id)
         VALUES ($1, 'player', $2, $3) RETURNING *`,
        [interviewId, `You show ${r.suspect.name} "${r.evidence.name}".`, evidenceId],
      );
      const message = rows[0]!;
      s.presentations.push({ suspectId, evidenceId, playerId: session.playerId, at: s.now });
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
          for (const ch of r.changes) {
            await tx.query(
              `UPDATE suspect_states SET state = $4, revision = revision + 1
                WHERE game_id = $1 AND suspect_id = $2 AND thread_id = $3`,
              [g.id, suspectId, ch.threadId, ch.to],
            );
            (s.suspectStates[suspectId] ??= {})[ch.threadId] = ch.to;
          }
          s.firedTransitions.push(t.id);
          s.lastProgressAt = s.now;
          firedId = t.id;
        }
      }
      await this.jobs.enqueueSuspectReply(tx, g.id, session.playerId, {
        interviewId,
        suspectId,
        triggerMessageId: String(message.id),
        transitionId: firedId,
        reaction: firedId ? null : r.reaction.kind === 'transition' ? null : r.reaction,
      });
      await this.touch(tx, g.id, firedId !== null);
      const out = toMessageDto(message);
      await emit(tx, g.id, `player:${session.playerId}`, 'message', { suspectId, message: out });
      await this.maybeAutoAdvance(tx, g, c, s);
      return out;
    });
    this.onWork();
    return dto;
  }

  /** The group's accusation. One per game; the verdict stays hidden until the host ends the game. */
  async accuse(session: Session, suspectId: string, evidenceIds: string[], reasoning: string) {
    return this.inGame(session.gameId, async (tx, g, c, s) => {
      const r = accuse(c, s, session.playerId, suspectId, evidenceIds);
      await tx.query(
        `INSERT INTO accusations (game_id, player_id, suspect_id, evidence_ids, reasoning, outcome)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [g.id, session.playerId, suspectId, r.evidenceIds, reasoning, r.outcome.id],
      );
      await this.touch(tx, g.id, true);
      await emit(tx, g.id, 'public', 'accusation', {
        by: session.displayName,
        suspect: { id: r.suspect.id, name: r.suspect.name },
        evidence: r.evidenceIds.map((id) => ({ id, name: c.evidence.find((e) => e.id === id)!.name })),
        reasoning,
      });
      return { ok: true as const };
    });
  }

  /** The host ends the investigation: the reveal becomes visible and commentary is queued. */
  async end(session: Session) {
    await this.inGame(session.gameId, async (tx, g, _c, s) => {
      endGame(s);
      await tx.query(`UPDATE games SET status = 'ended', ended_at = now(), revision = revision + 1 WHERE id = $1`, [
        g.id,
      ]);
      await emit(tx, g.id, 'public', 'game_ended', {});
      await this.jobs.enqueueCommentary(tx, g.id);
    });
    this.onWork();
  }

  /** The host gives the next hint in order now, whatever its delivery condition. */
  async giveHint(session: Session) {
    return this.inGame(session.gameId, async (tx, g, c, s) => {
      if (s.status !== 'active') throw new RuleError('game_not_active', 'The game is not in progress.');
      if (s.accusation) throw new RuleError('accusation_submitted', 'The accusation is already in.');
      const h = nextHint(c, s);
      if (!h) throw new RuleError('no_hint', 'Every hint has been given.');
      const iv = { id: `hint:${h.id}`, kind: 'hint' as const, text: hintText(h, s), recordId: `hint:${h.id}` };
      await applyIntervention(tx, g.id, iv, 'host');
      await this.touch(tx, g.id);
      return { text: iv.text };
    });
  }

  /**
   * Periodic upkeep for every active game: timed act changes, and a game-master tick when one
   * is due (none pending, the game not idle). Returns how many ticks were enqueued.
   */
  async periodic(): Promise<number> {
    const { rows } = await this.db.query<{ id: string }>("SELECT id FROM games WHERE status = 'active'");
    let ticks = 0;
    for (const { id } of rows) {
      ticks += await this.inGame(id, async (tx, g, c, s) => {
        if (g.status !== 'active') return 0;
        await this.maybeAutoAdvance(tx, g, c, s);
        if (this.timing.gmTickMs <= 0) return 0;
        const now = Date.now();
        const last = (g.last_gm_tick_at ?? g.last_activity_at).getTime();
        if (now - last < this.timing.gmTickMs) return 0;
        if (now - g.last_activity_at.getTime() > this.timing.idleMs) return 0;
        const enqueued = await this.jobs.enqueueGmTick(tx, g.id);
        if (enqueued) await tx.query('UPDATE games SET last_gm_tick_at = now() WHERE id = $1', [g.id]);
        return enqueued ? 1 : 0;
      });
    }
    return ticks;
  }
}
