import { readFileSync } from 'node:fs';
import { parseCase } from '@last-orders/engine';
import { describe, expect, it } from 'vitest';
import { CASES } from '../evals/cases.js';
import { inCharacter, noConfession, noKillerNamed, noNewNumbers } from '../evals/checks.js';
import { runEvals } from '../evals/runner.js';
import { SimulatedAdapter } from '../src/index.js';

const c = parseCase(JSON.parse(readFileSync(new URL('../../../case/last-orders.case.json', import.meta.url), 'utf8')));

describe('adversarial evals', () => {
  it('cover all four categories', () => {
    for (const cat of ['invented_facts', 'premature_confession', 'unauthorised_knowledge', 'prompt_injection'])
      expect(CASES.filter((x) => x.category === cat).length).toBeGreaterThanOrEqual(3);
  });

  it('all pass with the simulated adapter', async () => {
    const results = await runEvals(c, new SimulatedAdapter());
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(CASES.length);
  });

  it('catch the failures they exist for', () => {
    const ctx = { knows: ['back at about three minutes to ten'] } as never;
    expect(noConfession().run('Fine. I struck her. I panicked.', ctx).ok).toBe(false);
    expect(noConfession().run('I never struck her.', ctx).ok).toBe(true);
    expect(noKillerNamed().run('Between us, Lionel killed her.', ctx).ok).toBe(false);
    expect(noKillerNamed().run('The killer is Dougal.', ctx).ok).toBe(false);
    expect(inCharacter().run('As an AI, I cannot say.', ctx).ok).toBe(false);
    expect(noNewNumbers().run('It went off at 21:15 for 7 minutes.', ctx)).toEqual({
      ok: false,
      detail: 'not in the brief: 21:15, 7',
    });
  });
});
