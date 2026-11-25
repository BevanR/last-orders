import type { CaseFile } from './schema.js';
import { evaluateCondition, type GameState } from './state.js';
import { findSuspect, unlockedLocations } from './rules.js';
import type { EvidenceCard } from './redaction.js';

export interface HistoryEntry {
  role: 'player' | 'suspect' | 'system';
  text: string;
  presentedEvidenceId?: string | null;
}

/**
 * Everything the agent may know when voicing one suspect for one player. It holds one suspect's
 * brief and current knowledge slice only: no solution, no other suspect's hidden facts, no
 * transition triggers, no other player's interviews.
 */
export interface SuspectContext {
  setting: { title: string; intro: string; act: { number: number; name: string } };
  suspect: {
    id: string;
    name: string;
    role: string;
    persona: string;
    voice: string;
    unrelated_secret: string;
  };
  testimony: {
    state: string;
    account: string;
    facts: string[];
    authorised_lies: string[];
  };
  /** Public names and roles of the other suspects, so the character can refer to them. */
  others: { name: string; role: string }[];
  presented_evidence: EvidenceCard[];
  /** Set when this reply follows a transition that just fired. */
  fired_transition: { reaction: string; new_account: string } | null;
  history: HistoryEntry[];
}

export interface SuspectContextOptions {
  history: HistoryEntry[];
  firedTransitionId?: string | null;
}

export function buildSuspectContext(
  c: CaseFile,
  s: GameState,
  suspectId: string,
  opts: SuspectContextOptions,
): SuspectContext {
  const suspect = findSuspect(c, suspectId);
  const stateId = s.suspectStates[suspectId] ?? suspect.initial_state;
  const state = suspect.states.find((x) => x.id === stateId) ?? suspect.states[0]!;
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  const presentedIds = [
    ...new Set(opts.history.map((h) => h.presentedEvidenceId).filter((x): x is string => !!x)),
  ];
  const transition = opts.firedTransitionId
    ? c.transitions.find((t) => t.id === opts.firedTransitionId && t.suspect_id === suspectId)
    : undefined;
  return {
    setting: { title: c.title, intro: c.intro, act: { number: act.number, name: act.name } },
    suspect: {
      id: suspect.id,
      name: suspect.name,
      role: suspect.role,
      persona: suspect.persona,
      voice: suspect.voice,
      unrelated_secret: suspect.unrelated_secret,
    },
    testimony: {
      state: state.id,
      account: state.account,
      facts: state.facts.map((f) => f.text),
      authorised_lies: state.authorised_lies.map((f) => f.text),
    },
    others: c.suspects.filter((x) => x.id !== suspectId).map((x) => ({ name: x.name, role: x.role })),
    presented_evidence: presentedIds.flatMap((id) => {
      const e = c.evidence.find((x) => x.id === id);
      return e ? [{ id: e.id, name: e.name, description: e.description }] : [];
    }),
    fired_transition: transition
      ? {
          reaction: transition.reaction,
          new_account:
            suspect.states.find((x) => x.id === transition.to_state)?.account ?? state.account,
        }
      : null,
    history: opts.history.map((h) => ({ ...h })),
  };
}

export type InterventionKind = 'none' | 'hint' | 'highlight_location' | 'event' | 'suggest_advance';

export interface Intervention {
  /** `none`, `hint:<id>`, `highlight_location:<id>`, `event:<id>` or `suggest_advance`. */
  id: string;
  kind: InterventionKind;
  /** Authored text the app will show if this is chosen. The model may not alter it. */
  text: string;
}

/** The interventions the game master may choose from in the current state. */
export function allowedInterventions(c: CaseFile, s: GameState): Intervention[] {
  if (s.status !== 'active') return [{ id: 'none', kind: 'none', text: '' }];
  const out: Intervention[] = [{ id: 'none', kind: 'none', text: '' }];
  for (const h of c.hints) {
    if (!s.hintsGiven.includes(h.id) && evaluateCondition(h.condition, s))
      out.push({ id: `hint:${h.id}`, kind: 'hint', text: h.text });
  }
  for (const l of unlockedLocations(c, s)) {
    if (!s.visits.some((v) => v.locationId === l.id))
      out.push({ id: `highlight_location:${l.id}`, kind: 'highlight_location', text: l.name });
  }
  for (const e of c.atmospheric_events) {
    if (!s.eventsFired.includes(e.id) && evaluateCondition(e.condition, s))
      out.push({ id: `event:${e.id}`, kind: 'event', text: e.text });
  }
  const next = c.acts[s.act];
  if (next) out.push({ id: 'suggest_advance', kind: 'suggest_advance', text: next.name });
  return out;
}

export function isAllowedIntervention(c: CaseFile, s: GameState, id: string): boolean {
  return allowedInterventions(c, s).some((i) => i.id === id);
}

export interface GmContext {
  act: { number: number; name: string; total: number };
  minutesSinceProgress: number;
  discoveredEvidence: string[];
  sharedEvidence: string[];
  firedTransitions: string[];
  unvisitedLocations: string[];
  hintsGiven: string[];
  players: number;
  interventions: Intervention[];
}

/** Context for a game-master tick. Ids and authored text only; no solution. */
export function buildGmContext(c: CaseFile, s: GameState): GmContext {
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  return {
    act: { number: act.number, name: act.name, total: c.acts.length },
    minutesSinceProgress: Math.floor((s.now - s.lastProgressAt) / 60_000),
    discoveredEvidence: [...new Set(s.discoveries.map((d) => d.evidenceId))],
    sharedEvidence: s.board.map((b) => b.evidenceId),
    firedTransitions: [...s.firedTransitions],
    unvisitedLocations: unlockedLocations(c, s)
      .filter((l) => !s.visits.some((v) => v.locationId === l.id))
      .map((l) => l.id),
    hintsGiven: [...s.hintsGiven],
    players: s.players.length,
    interventions: allowedInterventions(c, s),
  };
}
