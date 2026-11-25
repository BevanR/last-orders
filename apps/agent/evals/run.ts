// Adversarial dialogue evals for the suspects. Runs every case in cases.ts against one adapter
// and prints pass or fail per case. Deterministic checks only; no model grades another.
//
//   npm run eval -w @last-orders/agent                       # simulated adapter (no model calls)
//   EVAL_ALLOW_MODEL_CALLS=1 npm run eval -w @last-orders/agent -- --adapter anthropic --model claude-haiku-5-5
//
// The anthropic adapter makes paid calls, so it refuses to run without EVAL_ALLOW_MODEL_CALLS=1.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseCase } from '@last-orders/engine';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { SimulatedAdapter } from '../src/adapters/simulated.js';
import type { ModelAdapter } from '../src/adapters/types.js';
import { runEvals } from './runner.js';

const { values } = parseArgs({
  options: {
    adapter: { type: 'string', default: 'simulated' },
    model: { type: 'string', default: 'claude-haiku-5-5' },
    case: { type: 'string', default: fileURLToPath(new URL('../../../case/last-orders.case.json', import.meta.url)) },
    only: { type: 'string' },
  },
});

let adapter: ModelAdapter;
if (values.adapter === 'simulated') adapter = new SimulatedAdapter();
else if (values.adapter === 'anthropic') {
  if (process.env.EVAL_ALLOW_MODEL_CALLS !== '1') {
    console.error('The anthropic adapter makes paid model calls. Set EVAL_ALLOW_MODEL_CALLS=1 to run it.');
    process.exit(2);
  }
  adapter = new AnthropicAdapter({
    model: values.model!,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    apiKey: process.env.ANTHROPIC_API_KEY || undefined,
  });
} else {
  console.error(`--adapter must be "simulated" or "anthropic", got "${values.adapter}"`);
  process.exit(2);
}

const c = parseCase(JSON.parse(readFileSync(values.case!, 'utf8')));
const label = values.adapter === 'anthropic' ? `anthropic (${values.model})` : 'simulated';
console.log(`Suspect evals: ${label}, case "${c.title}"\n`);
const results = await runEvals(c, adapter, values.only);
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id.padEnd(30)} ${r.category.padEnd(24)} ${r.suspect}`);
  for (const f of r.failures) console.log(`        - ${f}`);
  if (!r.ok) console.log(`        reply: ${r.reply.slice(0, 300)}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
