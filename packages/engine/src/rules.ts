import type { CaseFile, Evidence, Location, LocationAction, Outcome, Suspect, Transition } from './schema.js';
import { evaluateCondition, threadState, type GameState } from './state.js';

export type RuleErrorCode =
  | 'game_not_active'
  | 'game_not_in_lobby'
  | 'unknown_location'
  | 'location_locked'
  | 'unknown_action'
  | 'action_locked'
  | 'unknown_evidence'
  | 'evidence_not_held'
  | 'unknown_suspect'
  | 'no_next_act'
  | 'accusation_not_open'
  | 'accusation_submitted'
  | 'invalid_accusation'
  | 'no_hint';

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

/** Investigation actions are open while the game is active and no accusation has been made. */
function requireInvestigating(s: GameState) {
  requireActive(s);
  if (s.accusation)
    throw new RuleError('accusation_submitted', 'The accusation is in. Wait for the host to end the investigation.');
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

/** The actions open at a location now. Empty when the location itself is locked. */
export function unlockedActions(l: Location, s: GameState): LocationAction[] {
  return isLocationUnlocked(l, s) ? l.actions.filter((a) => evaluateCondition(a.unlock, s)) : [];
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
  action: LocationAction;
  /** Evidence this player has just found. */
  found: Evidence[];
}

/** A player performs a visible action at a location. Returns the evidence they newly find. */
export function discover(
  c: CaseFile,
  s: GameState,
  playerId: string,
  locationId: string,
  actionId: string,
): DiscoverResult {
  requireInvestigating(s);
  const location = c.locations.find((l) => l.id === locationId);
  if (!location) throw new RuleError('unknown_location', 'No such location.');
  if (!isLocationUnlocked(location, s))
    throw new RuleError('location_locked', 'That part of the lodge is not open yet.');
  const action = location.actions.find((a) => a.id === actionId);
  if (!action) throw new RuleError('unknown_action', 'You cannot do that here.');
  if (!evaluateCondition(action.unlock, s)) throw new RuleError('action_locked', 'You cannot do that yet.');
  const found = c.evidence.filter(
    (e) =>
      e.discovery.location_id === locationId &&
      e.discovery.action_id === actionId &&
      !playerHasDiscovered(s, playerId, e.id) &&
      evaluateCondition(e.unlock, s),
  );
  return { location, action, found };
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

export interface StateChange {
  threadId: string;
  from: string;
  to: string;
}

/** How the suspect responds to a presented card. The line is authored; the model only voices it. */
export type PresentReaction =
  | { kind: 'transition'; line: null }
  | { kind: 'reaction' | 'already_told' | 'default'; line: string };

export interface PresentResult {
  suspect: Suspect;
  evidence: Evidence;
  /** The authored transition that fires, or null when the testimony does not change. */
  transition: Transition | null;
  /** Thread state changes the transition makes, in order. */
  changes: StateChange[];
  reaction: PresentReaction;
}

/** The transition that a presentation would fire now, if any. */
export function matchingTransition(
  c: CaseFile,
  s: GameState,
  suspectId: string,
  evidenceId: string,
): Transition | null {
  return (
    c.transitions.find(
      (t) =>
        t.suspect_id === suspectId &&
        t.evidence_id === evidenceId &&
        threadState(c, s, suspectId, t.thread_id) === t.from_state &&
        s.act >= t.min_act &&
        !s.firedTransitions.includes(t.id) &&
        evaluateCondition(t.requires, s),
    ) ?? null
  );
}

/** The authored line for a card that fires nothing, chosen from the suspect's current state. */
export function reactionFor(c: CaseFile, s: GameState, suspect: Suspect, evidenceId: string): PresentReaction {
  const r = suspect.reactions.find((x) => x.evidence_id === evidenceId && evaluateCondition(x.when, s));
  if (r) return { kind: 'reaction', line: r.line };
  const told = c.transitions.some(
    (t) => t.suspect_id === suspect.id && t.evidence_id === evidenceId && s.firedTransitions.includes(t.id),
  );
  if (told && suspect.already_told_line) return { kind: 'already_told', line: suspect.already_told_line };
  return { kind: 'default', line: suspect.default_line };
}

/**
 * A player shows evidence to a suspect. Deterministic: a transition fires when the suspect's thread
 * is in its `from_state`, the evidence matches, the act is at least `min_act`, its `requires`
 * condition holds, and it has not fired. The caller must hold a lock on the game while applying it.
 */
export function present(
  c: CaseFile,
  s: GameState,
  playerId: string,
  suspectId: string,
  evidenceId: string,
): PresentResult {
  requireInvestigating(s);
  const suspect = findSuspect(c, suspectId);
  const evidence = findEvidence(c, evidenceId);
  if (!heldEvidenceIds(s, playerId).includes(evidenceId))
    throw new RuleError('evidence_not_held', 'You do not have that evidence.');
  const transition = matchingTransition(c, s, suspectId, evidenceId);
  if (!transition)
    return { suspect, evidence, transition, changes: [], reaction: reactionFor(c, s, suspect, evidenceId) };
  const changes: StateChange[] = [
    { threadId: transition.thread_id, from: transition.from_state, to: transition.to_state },
    ...transition.also_set
      .map((a) => ({ threadId: a.thread_id, from: threadState(c, s, suspectId, a.thread_id), to: a.state }))
      .filter((x) => x.from !== x.to),
  ];
  return { suspect, evidence, transition, changes, reaction: { kind: 'transition', line: null } };
}

/** Apply a fired transition to an in-memory state (the server mirrors this in SQL). */
export function applyPresent(s: GameState, r: PresentResult, playerId: string) {
  s.presentations.push({ suspectId: r.suspect.id, evidenceId: r.evidence.id, playerId, at: s.now });
  if (!r.transition) return;
  s.firedTransitions.push(r.transition.id);
  const threads = (s.suspectStates[r.suspect.id] ??= {});
  for (const ch of r.changes) threads[ch.threadId] = ch.to;
  s.lastProgressAt = s.now;
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

/** True when the group may submit its accusation now. */
export function accusationOpen(c: CaseFile, s: GameState): boolean {
  return s.status === 'active' && s.act >= c.accusation.min_act && s.accusation === null;
}

/**
 * The group's accusation: one suspect and up to `max_evidence` cards the submitting player holds
 * (their own finds or the board). One per game.
 */
export function accuse(c: CaseFile, s: GameState, playerId: string, suspectId: string, evidenceIds: string[]) {
  requireActive(s);
  if (s.accusation) throw new RuleError('accusation_submitted', 'The group has already made its accusation.');
  if (s.act < c.accusation.min_act)
    throw new RuleError('accusation_not_open', 'The accusation opens in the final act.');
  const suspect = findSuspect(c, suspectId);
  const ids = [...new Set(evidenceIds)];
  if (ids.length !== evidenceIds.length) throw new RuleError('invalid_accusation', 'Cite each card once.');
  if (ids.length > c.accusation.max_evidence)
    throw new RuleError('invalid_accusation', `Cite at most ${c.accusation.max_evidence} cards.`);
  const held = heldEvidenceIds(s, playerId);
  for (const id of ids) {
    findEvidence(c, id);
    if (!held.includes(id)) throw new RuleError('evidence_not_held', 'You can only cite cards you hold or the board.');
  }
  return { suspect, evidenceIds: ids, outcome: scoreAccusation(c, { suspectId, evidenceIds: ids }) };
}

/** Deterministic verdict. The outcomes are checked in order; the last one matches anything. */
export function scoreAccusation(c: CaseFile, a: { suspectId: string; evidenceIds: string[] }): Outcome {
  const cited = new Set(a.evidenceIds);
  const outcome = c.accusation.outcomes.find(
    (o) =>
      (!o.suspect_id || o.suspect_id === a.suspectId) &&
      o.cites_all.every((id) => cited.has(id)) &&
      (o.cites_any.length === 0 || o.cites_any.some((id) => cited.has(id))),
  );
  return outcome ?? c.accusation.outcomes.at(-1)!;
}

/** The host ends the investigation. */
export function endGame(s: GameState) {
  requireActive(s);
}

export interface AvailableActions {
  /** Location ids with at least one open action. */
  inspect: string[];
  interview: string[];
  share: string[];
  present: string[];
  accuse: boolean;
}

/** What a player can do right now. Ids only; the UI looks the names up in the redacted view. */
export function availableActions(c: CaseFile, s: GameState, playerId: string): AvailableActions {
  if (s.status !== 'active') return { inspect: [], interview: [], share: [], present: [], accuse: false };
  const sharedIds = new Set(s.board.map((b) => b.evidenceId));
  const investigating = s.accusation === null;
  return {
    inspect: investigating ? c.locations.filter((l) => unlockedActions(l, s).length > 0).map((l) => l.id) : [],
    interview: investigating ? c.suspects.map((x) => x.id) : [],
    share: s.discoveries
      .filter((d) => d.playerId === playerId && !sharedIds.has(d.evidenceId))
      .map((d) => d.evidenceId),
    present: investigating ? heldEvidenceIds(s, playerId) : [],
    accuse: accusationOpen(c, s),
  };
}
