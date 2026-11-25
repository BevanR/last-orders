import type { CaseFile, Verdict } from './schema.js';
import { scoreAccusation } from './rules.js';
import { evaluateCondition, type GameState } from './state.js';
import type { CommentaryContext } from './context.js';

export interface RevealCard {
  id: string;
  name: string;
}

/** Everything shown at the end. Built only once the host has ended the investigation. */
export interface Reveal {
  killer: { id: string; name: string };
  summary: string;
  motive: string;
  method: string;
  clues: { title: string; text: string }[];
  narration: string;
  /** Every authored red herring, with whether the group followed it (derived from its actions). */
  redHerrings: { id: string; title: string; text: string; followed: boolean }[];
  accusation: {
    by: string;
    suspect: { id: string; name: string };
    evidence: RevealCard[];
    reasoning: string;
  } | null;
  verdict: { outcome: string; verdict: Verdict | 'none'; title: string; text: string };
}

export function buildReveal(c: CaseFile, s: GameState): Reveal {
  const killer = c.suspects.find((x) => x.id === c.solution.killer_suspect_id)!;
  const a = s.accusation;
  const outcome = a ? scoreAccusation(c, a) : null;
  return {
    killer: { id: killer.id, name: killer.name },
    summary: c.solution.summary,
    motive: c.solution.motive,
    method: c.solution.method,
    clues: c.solution.clues.map((x) => ({ ...x })),
    narration: c.solution.narration,
    redHerrings: c.red_herrings.map((r) => ({
      id: r.id,
      title: r.title,
      text: r.text,
      followed: evaluateCondition(r.followed_when, s),
    })),
    accusation: a
      ? {
          by: s.players.find((p) => p.id === a.playerId)?.name ?? 'Someone',
          suspect: { id: a.suspectId, name: c.suspects.find((x) => x.id === a.suspectId)?.name ?? a.suspectId },
          evidence: a.evidenceIds.map((id) => ({ id, name: c.evidence.find((e) => e.id === id)?.name ?? id })),
          reasoning: a.reasoning,
        }
      : null,
    verdict: outcome
      ? { outcome: outcome.id, verdict: outcome.verdict, title: outcome.title, text: outcome.text }
      : { outcome: 'none', verdict: 'none', title: 'No accusation', text: c.accusation.none_text },
  };
}

export function buildCommentaryContext(c: CaseFile, s: GameState): CommentaryContext {
  return {
    title: c.title,
    reveal: buildReveal(c, s),
    stats: {
      evidenceFound: new Set(s.discoveries.map((d) => d.evidenceId)).size,
      evidenceTotal: c.evidence.length,
      transitionsFired: s.firedTransitions.length,
      transitionsTotal: c.transitions.length,
    },
  };
}
