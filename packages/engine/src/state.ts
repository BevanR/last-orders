import type { CaseFile, Condition } from './schema.js';

export type GameStatus = 'lobby' | 'active' | 'ended';

export interface PlayerRef {
  id: string;
  name: string;
  isHost: boolean;
}

export interface Discovery {
  evidenceId: string;
  playerId: string;
}

export interface BoardItem {
  evidenceId: string;
  sharedBy: string;
}

export interface Visit {
  locationId: string;
  playerId: string;
}

/**
 * Everything the rules need to know about one game. The server loads this from the database;
 * the engine never performs I/O. Times are epoch milliseconds.
 */
export interface GameState {
  status: GameStatus;
  act: number;
  players: PlayerRef[];
  /** suspect id -> testimony state id */
  suspectStates: Record<string, string>;
  discoveries: Discovery[];
  board: BoardItem[];
  firedTransitions: string[];
  visits: Visit[];
  hintsGiven: string[];
  eventsFired: string[];
  lastProgressAt: number;
  now: number;
}

export function initialSuspectStates(c: CaseFile): Record<string, string> {
  return Object.fromEntries(c.suspects.map((s) => [s.id, s.initial_state]));
}

/** A fresh game in the lobby. */
export function newGameState(c: CaseFile, now: number, players: PlayerRef[] = []): GameState {
  return {
    status: 'lobby',
    act: 1,
    players,
    suspectStates: initialSuspectStates(c),
    discoveries: [],
    board: [],
    firedTransitions: [],
    visits: [],
    hintsGiven: [],
    eventsFired: [],
    lastProgressAt: now,
    now,
  };
}

export function evaluateCondition(cond: Condition, s: GameState): boolean {
  if ('always' in cond) return true;
  if ('act_at_least' in cond) return s.act >= cond.act_at_least;
  if ('evidence_discovered' in cond) return s.discoveries.some((d) => d.evidenceId === cond.evidence_discovered);
  if ('evidence_shared' in cond) return s.board.some((b) => b.evidenceId === cond.evidence_shared);
  if ('location_visited' in cond) return s.visits.some((v) => v.locationId === cond.location_visited);
  if ('transition_fired' in cond) return s.firedTransitions.includes(cond.transition_fired);
  if ('suspect_in_state' in cond) return s.suspectStates[cond.suspect_in_state.suspect] === cond.suspect_in_state.state;
  if ('minutes_since_progress_at_least' in cond)
    return (s.now - s.lastProgressAt) / 60_000 >= cond.minutes_since_progress_at_least;
  if ('hint_given' in cond) return s.hintsGiven.includes(cond.hint_given);
  if ('all' in cond) return cond.all.every((x) => evaluateCondition(x, s));
  if ('any' in cond) return cond.any.some((x) => evaluateCondition(x, s));
  if ('not' in cond) return !evaluateCondition(cond.not, s);
  const exhaustive: never = cond;
  throw new Error(`unknown condition ${JSON.stringify(exhaustive)}`);
}
