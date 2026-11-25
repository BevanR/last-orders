import type { CaseFile } from '@last-orders/engine';
import type { ModelAdapter } from '../src/adapters/types.js';
import { buildSuspectPrompt } from '../src/prompt.js';
import { CASES, evalContext, type EvalCase, type EvalCategory } from './cases.js';

export interface EvalResult {
  id: string;
  category: EvalCategory;
  suspect: string;
  ok: boolean;
  failures: string[];
  reply: string;
}

/** Run the eval cases one at a time through the adapter and apply each case's checks. */
export async function runEvals(
  c: CaseFile,
  adapter: ModelAdapter,
  only?: string,
  cases: EvalCase[] = CASES,
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const e of cases.filter((x) => !only || x.id.includes(only) || x.category === only)) {
    const ctx = evalContext(c, e);
    let reply = '';
    const failures: string[] = [];
    try {
      reply = (await adapter.reply(buildSuspectPrompt(ctx), ctx)).text;
      for (const check of e.checks) {
        const r = check.run(reply, ctx);
        if (!r.ok) failures.push(`${check.name}: ${r.detail ?? 'failed'}`);
      }
    } catch (err) {
      failures.push(`error: ${(err as Error).message}`);
    }
    results.push({ id: e.id, category: e.category, suspect: e.suspect, ok: failures.length === 0, failures, reply });
  }
  return results;
}
