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
  const suspects = await q.query<{ suspect_id: string; state: string }>(
    'SELECT suspect_id, state FROM suspect_states WHERE game_id = $1',
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
  const visits = await q.query<{ location_id: string; player_id: string }>(
    'SELECT location_id, player_id FROM location_visits WHERE game_id = $1',
    [game.id],
  );
  const interventions = await q.query<{ intervention_id: string }>(
    'SELECT intervention_id FROM game_interventions WHERE game_id = $1',
    [game.id],
  );
  const prefixed = (prefix: string) =>
    interventions.rows
      .map((r) => r.intervention_id)
      .filter((id) => id.startsWith(prefix))
      .map((id) => id.slice(prefix.length));
  return {
    status: game.status,
    act: game.act,
    players: players.rows.map((p) => ({ id: p.id, name: p.display_name, isHost: p.is_host })),
    suspectStates: Object.fromEntries(suspects.rows.map((r) => [r.suspect_id, r.state])),
    discoveries: discoveries.rows.map((r) => ({ evidenceId: r.evidence_id, playerId: r.player_id })),
    board: board.rows.map((r) => ({ evidenceId: r.evidence_id, sharedBy: r.shared_by })),
    firedTransitions: fired.rows.map((r) => r.transition_id),
    visits: visits.rows.map((r) => ({ locationId: r.location_id, playerId: r.player_id })),
    hintsGiven: prefixed('hint:'),
    eventsFired: prefixed('event:'),
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
