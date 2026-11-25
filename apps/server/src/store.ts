import type { GameState, GameStatus } from '@last-orders/engine';
import { HttpError } from './errors.js';
import type { Db, Tx } from './db.js';

export interface GameRow {
  id: string;
  room_code: string;
  case_version_id: number;
  act: number;
  status: GameStatus;
  revision: number;
  event_seq: string;
  spend_cents: string;
  spend_cap_cents: number;
  last_progress_at: Date;
  act_started_at: Record<string, string>;
  last_activity_at: Date;
  last_gm_tick_at: Date | null;
  ended_at: Date | null;
  commentary: string | null;
  commentary_simulated: boolean;
}

/**
 * Lock the game row for the rest of the transaction. Every transaction that changes a game
 * takes this lock first (after any job row lock), which serialises rule decisions per game and
 * keeps a single lock order.
 */
export async function lockGame(tx: Tx, gameId: string): Promise<GameRow> {
  const { rows } = await tx.query<GameRow>('SELECT * FROM games WHERE id = $1 FOR UPDATE', [gameId]);
  if (!rows[0]) throw new HttpError(404, 'game_not_found', 'No such game.');
  return rows[0];
}

export async function findGameByCode(db: Db | Tx, code: string): Promise<GameRow> {
  const { rows } = await db.query<GameRow>('SELECT * FROM games WHERE room_code = $1', [code.toUpperCase()]);
  if (!rows[0]) throw new HttpError(404, 'room_not_found', 'No such room.');
  return rows[0];
}

/** Read everything the engine needs about one game. */
export async function loadState(q: Db | Tx, game: GameRow, now = Date.now()): Promise<GameState> {
  // Sequential: a transaction client runs one query at a time.
  const players = await q.query<{ id: string; display_name: string; is_host: boolean }>(
    'SELECT id, display_name, is_host FROM players WHERE game_id = $1 ORDER BY created_at, id',
    [game.id],
  );
  const suspects = await q.query<{ suspect_id: string; thread_id: string; state: string }>(
    'SELECT suspect_id, thread_id, state FROM suspect_states WHERE game_id = $1',
    [game.id],
  );
  const discoveries = await q.query<{ evidence_id: string; player_id: string }>(
    'SELECT evidence_id, player_id FROM evidence_discoveries WHERE game_id = $1 ORDER BY id',
    [game.id],
  );
  const board = await q.query<{ evidence_id: string; shared_by: string }>(
    'SELECT evidence_id, shared_by FROM board_items WHERE game_id = $1 ORDER BY id',
    [game.id],
  );
  const fired = await q.query<{ transition_id: string }>(
    'SELECT transition_id FROM testimony_transitions WHERE game_id = $1 ORDER BY id',
    [game.id],
  );
  const visits = await q.query<{ location_id: string; action_id: string; player_id: string }>(
    'SELECT location_id, action_id, player_id FROM location_visits WHERE game_id = $1 ORDER BY first_at',
    [game.id],
  );
  const presented = await q.query<{ suspect_id: string; evidence_id: string; player_id: string; at: Date }>(
    `SELECT i.suspect_id, m.presented_evidence_id AS evidence_id, i.player_id, m.created_at AS at
       FROM messages m JOIN interviews i ON i.id = m.interview_id
      WHERE i.game_id = $1 AND m.presented_evidence_id IS NOT NULL
      ORDER BY m.id`,
    [game.id],
  );
  const interviewed = await q.query<{ suspect_id: string }>(
    `SELECT DISTINCT i.suspect_id FROM interviews i
      WHERE i.game_id = $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.interview_id = i.id AND m.role = 'player')`,
    [game.id],
  );
  const interventions = await q.query<{ intervention_id: string; text: string; created_at: Date }>(
    'SELECT intervention_id, text, created_at FROM game_interventions WHERE game_id = $1 ORDER BY created_at, intervention_id',
    [game.id],
  );
  const accusation = await q.query<{
    player_id: string;
    suspect_id: string;
    evidence_ids: string[];
    reasoning: string;
    created_at: Date;
  }>('SELECT * FROM accusations WHERE game_id = $1', [game.id]);
  const suspectStates: GameState['suspectStates'] = {};
  for (const r of suspects.rows) (suspectStates[r.suspect_id] ??= {})[r.thread_id] = r.state;
  const a = accusation.rows[0];
  return {
    status: game.status,
    act: game.act,
    actStartedAt: Object.fromEntries(
      Object.entries(game.act_started_at ?? {}).map(([k, v]) => [Number(k), new Date(v).getTime()]),
    ),
    players: players.rows.map((p) => ({ id: p.id, name: p.display_name, isHost: p.is_host })),
    suspectStates,
    discoveries: discoveries.rows.map((r) => ({ evidenceId: r.evidence_id, playerId: r.player_id })),
    board: board.rows.map((r) => ({ evidenceId: r.evidence_id, sharedBy: r.shared_by })),
    firedTransitions: fired.rows.map((r) => r.transition_id),
    visits: visits.rows.map((r) => ({ locationId: r.location_id, actionId: r.action_id, playerId: r.player_id })),
    presentations: presented.rows.map((r) => ({
      suspectId: r.suspect_id,
      evidenceId: r.evidence_id,
      playerId: r.player_id,
      at: r.at.getTime(),
    })),
    interviewed: interviewed.rows.map((r) => r.suspect_id),
    interventions: interventions.rows.map((r) => ({
      id: r.intervention_id,
      text: r.text,
      at: r.created_at.getTime(),
    })),
    accusation: a
      ? {
          playerId: a.player_id,
          suspectId: a.suspect_id,
          evidenceIds: a.evidence_ids,
          reasoning: a.reasoning,
          at: a.created_at.getTime(),
        }
      : null,
    lastProgressAt: game.last_progress_at.getTime(),
    now,
  };
}

export interface MessageRow {
  id: string;
  interview_id: string;
  role: 'player' | 'suspect' | 'system';
  text: string;
  presented_evidence_id: string | null;
  job_id: string | null;
  simulated: boolean;
  created_at: Date;
}

export interface MessageDto {
  id: string;
  role: 'player' | 'suspect' | 'system';
  text: string;
  presentedEvidenceId: string | null;
  simulated: boolean;
  createdAt: string;
}

export function toMessageDto(m: MessageRow): MessageDto {
  return {
    id: String(m.id),
    role: m.role,
    text: m.text,
    presentedEvidenceId: m.presented_evidence_id,
    simulated: m.simulated,
    createdAt: m.created_at.toISOString(),
  };
}

/** Get or create the interview for one player and one suspect. */
export async function ensureInterview(tx: Tx, gameId: string, playerId: string, suspectId: string) {
  await tx.query(
    `INSERT INTO interviews (game_id, player_id, suspect_id) VALUES ($1, $2, $3)
     ON CONFLICT (game_id, player_id, suspect_id) DO NOTHING`,
    [gameId, playerId, suspectId],
  );
  const { rows } = await tx.query<{ id: string }>(
    'SELECT id FROM interviews WHERE game_id = $1 AND player_id = $2 AND suspect_id = $3',
    [gameId, playerId, suspectId],
  );
  return rows[0]!.id;
}
