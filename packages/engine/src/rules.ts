import type { CaseFile, Evidence, Location, Suspect, Transition } from './schema.js';
import { evaluateCondition, type GameState } from './state.js';

export type RuleErrorCode =
  | 'game_not_active'
  | 'game_not_in_lobby'
  | 'unknown_location'
  | 'location_locked'
  | 'unknown_evidence'
  | 'evidence_not_held'
  | 'unknown_suspect'
  | 'no_next_act';

export class RuleError extends Error {
  constructor(
    readonly code: RuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuleError';
  }
}

function requireActive(s: GameState) {
  if (s.status !== 'active') throw new RuleError('game_not_active', 'The game is not in progress.');
}

export function findSuspect(c: CaseFile, id: string): Suspect {
  const s = c.suspects.find((x) => x.id === id);
  if (!s) throw new RuleError('unknown_suspect', 'No such suspect.');
  return s;
}

export function findEvidence(c: CaseFile, id: string): Evidence {
  const e = c.evidence.find((x) => x.id === id);
  if (!e) throw new RuleError('unknown_evidence', 'No such evidence.');
  return e;
}

export function isLocationUnlocked(l: Location, s: GameState): boolean {
  return evaluateCondition(l.unlock, s);
}

export function unlockedLocations(c: CaseFile, s: GameState): Location[] {
  return c.locations.filter((l) => isLocationUnlocked(l, s));
}

/** Evidence ids the player may present or cite: their own finds plus the shared board. */
export function heldEvidenceIds(s: GameState, playerId: string): string[] {
  const ids = new Set<string>();
  for (const d of s.discoveries) if (d.playerId === playerId) ids.add(d.evidenceId);
  for (const b of s.board) ids.add(b.evidenceId);
  return [...ids];
}

export function playerHasDiscovered(s: GameState, playerId: string, evidenceId: string): boolean {
  return s.discoveries.some((d) => d.playerId === playerId && d.evidenceId === evidenceId);
}

export interface DiscoverResult {
  location: Location;
  /** Evidence this player has just found. */
  found: Evidence[];
}

/** A player inspects a location. Returns the evidence they newly find there. */
export function discover(c: CaseFile, s: GameState, playerId: string, locationId: string): DiscoverResult {
  requireActive(s);
  const location = c.locations.find((l) => l.id === locationId);
  if (!location) throw new RuleError('unknown_location', 'No such location.');
  if (!isLocationUnlocked(location, s))
    throw new RuleError('location_locked', 'That part of the lodge is not open yet.');
  const found = c.evidence.filter(
    (e) =>
      e.discovery.action === 'inspect' &&
      e.discovery.location_id === locationId &&
      !playerHasDiscovered(s, playerId, e.id) &&
      evaluateCondition(e.unlock, s),
  );
  return { location, found };
}

export interface ShareResult {
  evidence: Evidence;
  alreadyOnBoard: boolean;
}

/** A player pins evidence they found to the shared board. */
export function share(c: CaseFile, s: GameState, playerId: string, evidenceId: string): ShareResult {
  requireActive(s);
  const evidence = findEvidence(c, evidenceId);
  if (!playerHasDiscovered(s, playerId, evidenceId))
    throw new RuleError('evidence_not_held', 'You have not found that evidence.');
  return { evidence, alreadyOnBoard: s.board.some((b) => b.evidenceId === evidenceId) };
}

export interface PresentResult {
  suspect: Suspect;
  evidence: Evidence;
  /** The authored transition that fires, or null when the testimony does not change. */
  transition: Transition | null;
  /** Evidence handed to the presenting player because the transition fired. */
  revealed: Evidence[];
}

/**
 * A player shows evidence to a suspect. Deterministic: a transition fires when the suspect is in
 * its `from_state`, the evidence matches, the act is at least `min_act`, and it has not fired.
 * The caller must hold a lock on the suspect's state while applying the result.
 */
export function present(
  c: CaseFile,
  s: GameState,
  playerId: string,
  suspectId: string,
  evidenceId: string,
): PresentResult {
  requireActive(s);
  const suspect = findSuspect(c, suspectId);
  const evidence = findEvidence(c, evidenceId);
  if (!heldEvidenceIds(s, playerId).includes(evidenceId))
    throw new RuleError('evidence_not_held', 'You do not have that evidence.');
  const current = s.suspectStates[suspectId] ?? suspect.initial_state;
  const transition =
    c.transitions.find(
      (t) =>
        t.suspect_id === suspectId &&
        t.from_state === current &&
        t.evidence_id === evidenceId &&
        s.act >= t.min_act &&
        !s.firedTransitions.includes(t.id),
    ) ?? null;
  const revealed = transition
    ? c.evidence.filter(
        (e) => e.discovery.action === 'transition' && e.discovery.transition_id === transition.id,
      )
    : [];
  return { suspect, evidence, transition, revealed };
}

/** Starting the game moves it from the lobby to act 1. */
export function start(s: GameState): { act: number } {
  if (s.status !== 'lobby') throw new RuleError('game_not_in_lobby', 'The game has already started.');
  return { act: 1 };
}

/** The host moves the game to the next act. */
export function advanceAct(c: CaseFile, s: GameState): { act: number } {
  requireActive(s);
  if (s.act >= c.acts.length) throw new RuleError('no_next_act', 'This is the final act.');
  return { act: s.act + 1 };
}

/** The act the game should move to on its own, or null when it should stay. */
export function autoAdvance(c: CaseFile, s: GameState): number | null {
  if (s.status !== 'active' || s.act >= c.acts.length) return null;
  const cond = c.acts[s.act - 1]?.auto_advance;
  return cond && evaluateCondition(cond, s) ? s.act + 1 : null;
}

export interface AvailableActions {
  inspect: string[];
  interview: string[];
  share: string[];
  present: string[];
}

/** What a player can do right now. Ids only; the UI looks the names up in the redacted view. */
export function availableActions(c: CaseFile, s: GameState, playerId: string): AvailableActions {
  if (s.status !== 'active') return { inspect: [], interview: [], share: [], present: [] };
  const sharedIds = new Set(s.board.map((b) => b.evidenceId));
  return {
    inspect: unlockedLocations(c, s).map((l) => l.id),
    interview: c.suspects.map((x) => x.id),
    share: s.discoveries
      .filter((d) => d.playerId === playerId && !sharedIds.has(d.evidenceId))
      .map((d) => d.evidenceId),
    present: heldEvidenceIds(s, playerId),
  };
}
