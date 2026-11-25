import type { CommentaryContext, GmContext, SuspectContext } from '@last-orders/engine';
import { currentAccount, type SuspectPrompt, type TextPrompt } from '../prompt.js';
import type { GmChoice, ModelAdapter, ModelReply } from './types.js';

/** Phrases that try to take the suspect out of the story. The simulated suspect never plays along. */
const INJECTION = [
  /ignore (all |any |your |the |previous |prior )*(instructions|rules|prompt)/,
  /system prompt/,
  /developer mode/,
  /(reveal|tell me|name|who is|who's|who was) (the )?(killer|murderer)/,
  /who killed/,
  /you are an? (ai|language model|assistant)/,
  /(print|show|repeat|list) (your|the) (instructions|rules|brief|secrets?)/,
  /out of character/,
];

const STOPWORDS = new Set(
  'about again also because been before being could does doing done from have here into just know like more much said some tell than that them then there they this those were what when which while will with would your yours really think please want should after'.split(
    ' ',
  ),
);

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9:'$]+/g) ?? []).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * Deterministic replies built only from the authored lines in the context. No model call. Every
 * reply starts with `[simulated]` and is stored with `simulated = true`.
 */
export class SimulatedAdapter implements ModelAdapter {
  readonly name = 'simulated';

  async reply(_prompt: SuspectPrompt, ctx: SuspectContext): Promise<ModelReply> {
    return { text: simulatedReply(ctx), usage: null, simulated: true };
  }

  async chooseIntervention(_prompt: TextPrompt, ctx: GmContext): Promise<GmChoice> {
    return { ...simulatedGmChoice(ctx), usage: null, simulated: true };
  }

  async commentary(_prompt: TextPrompt, ctx: CommentaryContext): Promise<ModelReply> {
    return { text: simulatedCommentary(ctx), usage: null, simulated: true };
  }
}

export function simulatedReply(ctx: SuspectContext): string {
  const say = (line: string) => `[simulated] ${ctx.suspect.name}: "${line}"`;
  const t = ctx.turn;
  if (t.kind === 'transition') return `[simulated] ${ctx.suspect.name}: (${t.reaction}) "${t.account}"`;
  if (t.kind === 'evidence') return say(t.line);
  if (t.kind === 'account') return say(currentAccount(ctx));

  const q = t.text.toLowerCase();
  if (INJECTION.some((re) => re.test(q))) return say(ctx.dont_know_line);
  const fixed = ctx.situational_lines.find((l) => l.keywords.some((k) => q.includes(k)));
  if (fixed) return say(fixed.line);

  // Answer with the authored statement that shares the most words with the question.
  const asked = new Set(words(t.text));
  const score = (text: string) => [...new Set(words(text))].filter((w) => asked.has(w)).length;
  const candidates: { line: string; score: number }[] = [
    // A lie is matched on its trigger as well as its words, and wins ties.
    ...ctx.authorised_lies.map((l) => ({ line: l.text, score: score(`${l.text} ${l.when ?? ''}`) + 0.5 })),
    ...ctx.account.changes.map((a) => ({ line: a, score: score(a) })),
    // A fact kept back for direct questions wins a tie: the question was direct enough to match it.
    ...ctx.not_volunteered.map((f) => ({ line: f, score: score(f) + 0.25 })),
    ...[...ctx.knows, ...ctx.shared_knowledge].map((f) => ({ line: f, score: score(f) })),
    ...ctx.believes.map((b) => ({ line: b, score: score(b) })),
  ];
  const quiet = Math.max(0, ...ctx.keep_quiet.map(score));
  let best: { line: string; score: number } | null = null;
  for (const c of candidates) if (c.score >= 1 && (!best || c.score > best.score)) best = c;
  if (!best || quiet > best.score) return say(ctx.dont_know_line);
  return say(best.line);
}

/** A fixed policy: hints first, then the host suggestion, notices, highlights, and events in a lull. */
export function simulatedGmChoice(ctx: GmContext): { choice_id: string; reason: string } {
  const pick = (kind: string) => ctx.interventions.find((i) => i.kind === kind);
  const hint = pick('hint');
  if (hint)
    return { choice_id: hint.id, reason: `No progress for ${ctx.minutesSinceProgress} minutes; a hint is due.` };
  const suggest = pick('suggest_advance');
  if (suggest) return { choice_id: suggest.id, reason: 'The key evidence is found; tell the host.' };
  const notice = pick('notice');
  if (notice) return { choice_id: notice.id, reason: 'A notice is due.' };
  const highlight = pick('highlight_location');
  if (highlight) return { choice_id: highlight.id, reason: 'A place has been ignored.' };
  const quiet = ctx.minutesSinceLastIntervention === null || ctx.minutesSinceLastIntervention >= 3;
  const event = pick('event');
  if (event && quiet && ctx.minutesSinceProgress >= 3)
    return { choice_id: event.id, reason: 'A lull; add atmosphere.' };
  return { choice_id: 'none', reason: 'The players are making progress.' };
}

export function simulatedCommentary(ctx: CommentaryContext): string {
  const r = ctx.reveal;
  const parts = [
    r.accusation
      ? `The group accused ${r.accusation.suspect.name}${r.accusation.evidence.length ? `, citing ${r.accusation.evidence.map((e) => e.name).join(', ')}` : ''}.`
      : 'The group made no accusation.',
    `Verdict: ${r.verdict.title}.`,
    `They found ${ctx.stats.evidenceFound} of ${ctx.stats.evidenceTotal} cards and changed ${ctx.stats.transitionsFired} of ${ctx.stats.transitionsTotal} stories.`,
  ];
  const followed = r.redHerrings.filter((h) => h.followed).map((h) => h.title);
  if (followed.length) parts.push(`Along the way they followed: ${followed.join('; ')}.`);
  return `[simulated] ${parts.join(' ')}`;
}
