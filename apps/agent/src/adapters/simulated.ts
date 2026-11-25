import type { SuspectContext } from '@last-orders/engine';
import type { SuspectPrompt } from '../prompt.js';
import type { ModelAdapter, ModelReply } from './types.js';

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Deterministic replies built from the authored facts. No model call. Every reply starts with
 * `[simulated]` and is stored with `simulated = true`.
 */
export class SimulatedAdapter implements ModelAdapter {
  readonly name = 'simulated';

  async reply(_prompt: SuspectPrompt, ctx: SuspectContext): Promise<ModelReply> {
    return { text: simulatedReply(ctx), usage: null, simulated: true };
  }
}

export function simulatedReply(ctx: SuspectContext): string {
  const name = ctx.suspect.name;
  if (ctx.fired_transition) {
    return `[simulated] ${name}: (${ctx.fired_transition.reaction}) ${ctx.fired_transition.new_account}`;
  }
  const last = [...ctx.history].reverse().find((h) => h.role === 'player');
  const said = [...ctx.testimony.facts, ...ctx.testimony.authorised_lies];
  if (last?.presentedEvidenceId) {
    const e = ctx.presented_evidence.find((x) => x.id === last.presentedEvidenceId);
    return `[simulated] ${name} glances at the ${e?.name.toLowerCase() ?? 'evidence'}. "That means nothing to me."`;
  }
  if (said.length === 0) return `[simulated] ${name}: "I don't know anything about that."`;
  const line = said[hash(last?.text ?? '') % said.length]!;
  return `[simulated] ${name}: "${line}"`;
}
