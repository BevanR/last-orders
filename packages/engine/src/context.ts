import type { CaseFile, Hint, Lie } from './schema.js';
import { evaluateCondition, interventionGiven, threadState, type GameState } from './state.js';
import { findSuspect, unlockedLocations, type PresentReaction } from './rules.js';
import type { EvidenceCard } from './redaction.js';
import type { Reveal } from './reveal.js';

export interface HistoryEntry {
  role: 'player' | 'suspect' | 'system';
  text: string;
  presentedEvidenceId?: string | null;
}

/** What the suspect must do in this reply. */
export type SuspectTurn =
  /** A transition just fired: react as directed and give the new account. */
  | { kind: 'transition'; reaction: string; account: string }
  /** A card was shown that changes nothing: say (in your voice) this authored line. */
  | { kind: 'evidence'; evidence: EvidenceCard; line: string }
  /** The player's first turn with this suspect: give the current account. */
  | { kind: 'account' }
  /** An ordinary question. */
  | { kind: 'question'; text: string };

/**
 * Everything the agent may know when voicing one suspect for one player. It holds one suspect's
 * brief and current knowledge slice only: no solution, no other suspect's hidden facts, no
 * transition triggers, no other player's interviews. The killer's brief never says what he did;
 * it holds only what he may say.
 */
export interface SuspectContext {
  setting: { title: string; intro: string; act: { number: number; name: string } };
  suspect: {
    id: string;
    name: string;
    age: number;
    role: string;
    persona: string;
    voice: string;
    voice_examples: string[];
  };
  /** What this suspect saw and heard along with others at the dinner. */
  shared_knowledge: string[];
  /** True facts the suspect may state now. */
  knows: string[];
  /** True facts the suspect gives only when asked directly about the topic. */
  not_volunteered: string[];
  believes: string[];
  /** Topics to deflect now. */
  keep_quiet: string[];
  authorised_lies: Lie[];
  /** The suspect's unrelated secret, and whether they have admitted it. */
  secret: { text: string; admitted: boolean } | null;
  /**
   * The first account, then the current account on each thread that has changed, in the order
   * the changes happened. A later change on the same thread replaces an earlier one.
   */
  account: { first: string; changes: string[] };
  /** Fixed lines for situations the player creates, e.g. a forceful accusation. */
  situational_lines: { cue: string; keywords: string[]; line: string }[];
  default_line: string;
  dont_know_line: string;
  /** Public names and roles of the other suspects, so the character can refer to them. */
  others: { name: string; role: string }[];
  /** Cards shown in this interview, for rendering the history. */
  presented_evidence: EvidenceCard[];
  turn: SuspectTurn;
  history: HistoryEntry[];
}

export interface SuspectContextOptions {
  history: HistoryEntry[];
  /** Set when this reply follows a transition that just fired. */
  firedTransitionId?: string | null;
  /** Set when this reply follows a card that fired nothing. */
  reaction?: PresentReaction | null;
}

function card(c: CaseFile, id: string): EvidenceCard | null {
  const e = c.evidence.find((x) => x.id === id);
  return e ? { id: e.id, name: e.name, description: e.description } : null;
}

export function buildSuspectContext(
  c: CaseFile,
  s: GameState,
  suspectId: string,
  opts: SuspectContextOptions,
): SuspectContext {
  const suspect = findSuspect(c, suspectId);
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  const states = suspect.threads.map((t) => {
    const id = threadState(c, s, suspectId, t.id);
    return t.states.find((x) => x.id === id) ?? t.states.find((x) => x.id === t.initial_state)!;
  });
  const presentedIds = [...new Set(opts.history.map((h) => h.presentedEvidenceId).filter((x): x is string => !!x))];
  // The latest fired transition on each thread carries that thread's current account.
  const fired = c.transitions.filter((t) => t.suspect_id === suspectId && s.firedTransitions.includes(t.id));
  fired.sort((a, b) => s.firedTransitions.indexOf(a.id) - s.firedTransitions.indexOf(b.id));
  const latest = new Map<string, (typeof fired)[number]>();
  for (const t of fired) for (const th of [t.thread_id, ...t.also_set.map((x) => x.thread_id)]) latest.set(th, t);
  const changes = [...new Set(latest.values())];
  changes.sort((a, b) => s.firedTransitions.indexOf(a.id) - s.firedTransitions.indexOf(b.id));

  const last = [...opts.history].reverse().find((h) => h.role === 'player');
  const firstTurn = !opts.history.some((h) => h.role === 'suspect');
  const transition = opts.firedTransitionId
    ? c.transitions.find((t) => t.id === opts.firedTransitionId && t.suspect_id === suspectId)
    : undefined;
  const shown = last?.presentedEvidenceId ? card(c, last.presentedEvidenceId) : null;
  let turn: SuspectTurn;
  if (transition) turn = { kind: 'transition', reaction: transition.reaction, account: transition.account };
  else if (shown && opts.reaction && opts.reaction.kind !== 'transition')
    turn = { kind: 'evidence', evidence: shown, line: opts.reaction.line };
  else if (shown) turn = { kind: 'evidence', evidence: shown, line: suspect.default_line };
  else if (firstTurn) turn = { kind: 'account' };
  else turn = { kind: 'question', text: last?.text ?? '' };

  return {
    setting: { title: c.title, intro: c.intro, act: { number: act.number, name: act.name } },
    suspect: {
      id: suspect.id,
      name: suspect.name,
      age: suspect.age,
      role: suspect.role,
      persona: suspect.persona,
      voice: suspect.voice,
      voice_examples: [...suspect.voice_examples],
    },
    shared_knowledge: c.shared_knowledge.filter((k) => k.known_by.includes(suspectId)).map((k) => k.text),
    knows: [...suspect.knows, ...states.flatMap((st) => st.facts)],
    not_volunteered: [...suspect.not_volunteered],
    believes: [...suspect.believes],
    keep_quiet: states.flatMap((st) => st.keep_quiet),
    authorised_lies: states.flatMap((st) => st.authorised_lies.map((l) => ({ ...l }))),
    secret: suspect.unrelated_secret
      ? {
          text: suspect.unrelated_secret.text,
          admitted: s.firedTransitions.includes(suspect.unrelated_secret.revealed_by),
        }
      : null,
    account: { first: suspect.first_account, changes: changes.map((t) => t.account) },
    situational_lines: suspect.situational_lines
      .filter((l) => evaluateCondition(l.when, s))
      .map((l) => ({ cue: l.cue, keywords: [...l.keywords], line: l.line })),
    default_line: suspect.default_line,
    dont_know_line: suspect.dont_know_line,
    others: c.suspects.filter((x) => x.id !== suspectId).map((x) => ({ name: x.name, role: x.role })),
    presented_evidence: presentedIds.flatMap((id) => {
      const k = card(c, id);
      return k ? [k] : [];
    }),
    turn,
    history: opts.history.map((h) => ({ ...h })),
  };
}

export type InterventionKind = 'none' | 'hint' | 'highlight_location' | 'event' | 'notice' | 'suggest_advance';

export interface Intervention {
  /** The choice id: `none`, `hint:<id>`, `highlight_location:<id>`, `event:<id>`, `notice:<id>` or `suggest_advance`. */
  id: string;
  kind: InterventionKind;
  /** Authored text the app will show if this is chosen. The model may not alter it. */
  text: string;
  /** The id stored when it is applied, so each intervention happens once. */
  recordId: string;
}

export function hintText(h: Hint, s: GameState): string {
  return h.variants.find((v) => evaluateCondition(v.when, s))?.text ?? h.text;
}

/** The next hint in order that has not been given, whatever its condition. */
export function nextHint(c: CaseFile, s: GameState): Hint | null {
  return c.hints.find((h) => !interventionGiven(s, `hint:${h.id}`)) ?? null;
}

/** The interventions the game master may choose from in the current state. */
export function allowedInterventions(c: CaseFile, s: GameState): Intervention[] {
  const out: Intervention[] = [{ id: 'none', kind: 'none', text: '', recordId: '' }];
  if (s.status !== 'active') return out;
  const fresh = (id: string) => !interventionGiven(s, id);
  if (!s.accusation) {
    const h = nextHint(c, s);
    if (h && evaluateCondition(h.condition, s))
      out.push({ id: `hint:${h.id}`, kind: 'hint', text: hintText(h, s), recordId: `hint:${h.id}` });
    const open = new Set(unlockedLocations(c, s).map((l) => l.id));
    for (const g of c.gm_interventions) {
      if (!evaluateCondition(g.condition, s)) continue;
      if (g.kind === 'highlight_location') {
        const id = `highlight_location:${g.location_id}`;
        if (open.has(g.location_id) && fresh(id))
          out.push({ id, kind: 'highlight_location', text: g.text, recordId: id });
      } else {
        const id = `notice:${g.id}`;
        if (fresh(id)) out.push({ id, kind: 'notice', text: g.text, recordId: id });
      }
    }
    const act = c.acts[s.act - 1];
    const next = c.acts[s.act];
    const record = `suggest_advance:${s.act}`;
    if (next && act?.suggest_advance && evaluateCondition(act.suggest_advance, s) && fresh(record))
      out.push({
        id: 'suggest_advance',
        kind: 'suggest_advance',
        text: `The group looks ready for Act ${next.number}: ${next.name}.`,
        recordId: record,
      });
  }
  for (const e of c.atmospheric_events) {
    const id = `event:${e.id}`;
    if (fresh(id) && evaluateCondition(e.condition, s)) out.push({ id, kind: 'event', text: e.text, recordId: id });
  }
  return out;
}

export function findAllowedIntervention(c: CaseFile, s: GameState, id: string): Intervention | undefined {
  return allowedInterventions(c, s).find((i) => i.id === id);
}

export function isAllowedIntervention(c: CaseFile, s: GameState, id: string): boolean {
  return findAllowedIntervention(c, s, id) !== undefined;
}

export interface GmContext {
  title: string;
  act: { number: number; name: string; total: number };
  minutesInAct: number;
  minutesSinceProgress: number;
  /** Evidence ids at least one player has found, and those on the shared board. */
  discoveredEvidence: string[];
  sharedEvidence: string[];
  totalEvidence: number;
  firedTransitions: number;
  suspectsInterviewed: number;
  unvisitedLocations: string[];
  hintsGiven: string[];
  minutesSinceLastIntervention: number | null;
  accusationSubmitted: boolean;
  players: number;
  interventions: Intervention[];
}

/** Context for a game-master tick. Ids, counts and authored text only; no solution. */
export function buildGmContext(c: CaseFile, s: GameState): GmContext {
  const act = c.acts[s.act - 1] ?? c.acts[0]!;
  const started = s.actStartedAt[s.act] ?? s.now;
  const lastIntervention = Math.max(-Infinity, ...s.interventions.map((i) => i.at));
  return {
    title: c.title,
    act: { number: act.number, name: act.name, total: c.acts.length },
    minutesInAct: Math.floor((s.now - started) / 60_000),
    minutesSinceProgress: Math.floor((s.now - s.lastProgressAt) / 60_000),
    discoveredEvidence: [...new Set(s.discoveries.map((d) => d.evidenceId))],
    sharedEvidence: s.board.map((b) => b.evidenceId),
    totalEvidence: c.evidence.length,
    firedTransitions: s.firedTransitions.length,
    suspectsInterviewed: new Set(s.interviewed).size,
    unvisitedLocations: unlockedLocations(c, s)
      .filter((l) => !s.visits.some((v) => v.locationId === l.id))
      .map((l) => l.id),
    hintsGiven: s.interventions.filter((i) => i.id.startsWith('hint:')).map((i) => i.id.slice(5)),
    minutesSinceLastIntervention: Number.isFinite(lastIntervention)
      ? Math.floor((s.now - lastIntervention) / 60_000)
      : null,
    accusationSubmitted: s.accusation !== null,
    players: s.players.length,
    interventions: allowedInterventions(c, s),
  };
}

/** Context for the optional reveal commentary. Built only after the game has ended. */
export interface CommentaryContext {
  title: string;
  reveal: Reveal;
  stats: { evidenceFound: number; evidenceTotal: number; transitionsFired: number; transitionsTotal: number };
}
