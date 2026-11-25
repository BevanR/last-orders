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
  /** The action performed. */
  actionId: string;
}

export interface Presentation {
  suspectId: string;
  evidenceId: string;
  playerId: string;
  at: number;
}

/** A game-master intervention that was applied: `hint:<id>`, `event:<id>`, `highlight_location:<id>`, ... */
export interface AppliedIntervention {
  id: string;
  text: string;
  at: number;
}

export interface Accusation {
  playerId: string;
  suspectId: string;
  evidenceIds: string[];
  reasoning: string;
  at: number;
}

/** suspect id -> thread id -> state id */
export type SuspectStates = Record<string, Record<string, string>>;

/**
 * Everything the rules need to know about one game. The server loads this from the database;
 * the engine never performs I/O. Times are epoch milliseconds.
 */
export interface GameState {
  status: GameStatus;
  act: number;
  /** act number -> when it started */
  actStartedAt: Record<number, number>;
  players: PlayerRef[];
  suspectStates: SuspectStates;
  discoveries: Discovery[];
  board: BoardItem[];
  firedTransitions: string[];
  visits: Visit[];
  presentations: Presentation[];
  /** Suspects at least one player has interviewed (each gives their account on the first turn). */
  interviewed: string[];
  interventions: AppliedIntervention[];
  accusation: Accusation | null;
  lastProgressAt: number;
  now: number;
}

export function initialSuspectStates(c: CaseFile): SuspectStates {
  return Object.fromEntries(
    c.suspects.map((s) => [s.id, Object.fromEntries(s.threads.map((t) => [t.id, t.initial_state]))]),
  );
}

/** A fresh game in the lobby. */
export function newGameState(c: CaseFile, now: number, players: PlayerRef[] = []): GameState {
  return {
    status: 'lobby',
    act: 1,
    actStartedAt: {},
    players,
    suspectStates: initialSuspectStates(c),
    discoveries: [],
    board: [],
    firedTransitions: [],
    visits: [],
    presentations: [],
    interviewed: [],
    interventions: [],
    accusation: null,
    lastProgressAt: now,
    now,
  };
}

/** The suspect's current state on one thread. */
export function threadState(c: CaseFile, s: GameState, suspectId: string, threadId: string): string {
  const current = s.suspectStates[suspectId]?.[threadId];
  if (current) return current;
  const thread = c.suspects.find((x) => x.id === suspectId)?.threads.find((t) => t.id === threadId);
  return thread?.initial_state ?? '';
}

export function hintsGiven(s: GameState): string[] {
  return s.interventions.filter((i) => i.id.startsWith('hint:')).map((i) => i.id.slice('hint:'.length));
}

export function interventionGiven(s: GameState, id: string): AppliedIntervention | undefined {
  return s.interventions.find((i) => i.id === id);
}

const minutes = (ms: number) => ms / 60_000;

export function evaluateCondition(cond: Condition, s: GameState): boolean {
  if ('always' in cond) return true;
  if ('act_at_least' in cond) return s.act >= cond.act_at_least;
  if ('minutes_since_act_started' in cond) {
    const { act, minutes: m } = cond.minutes_since_act_started;
    const started = s.actStartedAt[act];
    return s.act >= act && started !== undefined && minutes(s.now - started) >= m;
  }
  if ('evidence_discovered' in cond) return s.discoveries.some((d) => d.evidenceId === cond.evidence_discovered);
  if ('evidence_shared' in cond) return s.board.some((b) => b.evidenceId === cond.evidence_shared);
  if ('evidence_presented' in cond)
    return s.presentations.some(
      (p) => p.suspectId === cond.evidence_presented.suspect && p.evidenceId === cond.evidence_presented.evidence,
    );
  if ('location_visited' in cond) return s.visits.some((v) => v.locationId === cond.location_visited);
  if ('transition_fired' in cond) return s.firedTransitions.includes(cond.transition_fired);
  if ('suspect_in_state' in cond)
    return Object.values(s.suspectStates[cond.suspect_in_state.suspect] ?? {}).includes(cond.suspect_in_state.state);
  if ('accounts_given_at_least' in cond) return new Set(s.interviewed).size >= cond.accounts_given_at_least;
  if ('minutes_since_progress_at_least' in cond)
    return minutes(s.now - s.lastProgressAt) >= cond.minutes_since_progress_at_least;
  if ('minutes_since_presented_to_at_least' in cond) {
    const { suspect, minutes: m } = cond.minutes_since_presented_to_at_least;
    const last = Math.max(-Infinity, ...s.presentations.filter((p) => p.suspectId === suspect).map((p) => p.at));
    return minutes(s.now - last) >= m;
  }
  if ('hint_given' in cond) return hintsGiven(s).includes(cond.hint_given);
  if ('hint_given_minutes_ago_at_least' in cond) {
    const { hint, minutes: m } = cond.hint_given_minutes_ago_at_least;
    const given = interventionGiven(s, `hint:${hint}`);
    return given !== undefined && minutes(s.now - given.at) >= m;
  }
  if ('accusation_submitted' in cond) return s.accusation !== null;
  if ('accused' in cond) return s.accusation?.suspectId === cond.accused;
  if ('all' in cond) return cond.all.every((x) => evaluateCondition(x, s));
  if ('any' in cond) return cond.any.some((x) => evaluateCondition(x, s));
  if ('not' in cond) return !evaluateCondition(cond.not, s);
  if ('at_least' in cond) return cond.at_least.of.filter((x) => evaluateCondition(x, s)).length >= cond.at_least.n;
  const exhaustive: never = cond;
  throw new Error(`unknown condition ${JSON.stringify(exhaustive)}`);
}
