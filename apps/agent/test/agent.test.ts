import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  buildSuspectContext,
  newGameState,
  parseCase,
  type ClaimedJob,
  type SuspectContext,
} from '@last-orders/engine';
import { describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  AppApiError,
  buildSuspectPrompt,
  createWakeServer,
  SimulatedAdapter,
  simulatedReply,
  Worker,
  type AppClient,
} from '../src/index.js';

const c = parseCase(
  JSON.parse(
    readFileSync(new URL('../../../packages/engine/test/fixtures/fixture.case.json', import.meta.url), 'utf8'),
  ),
);
const state = { ...newGameState(c, 0), status: 'active' as const };

function ctx(history: SuspectContext['history'], firedTransitionId: string | null = null): SuspectContext {
  return buildSuspectContext(c, state, 'ada', { history, firedTransitionId });
}

describe('prompt builder', () => {
  it('alternates turns, ends with the player, and renders presented evidence', () => {
    const p = buildSuspectPrompt(
      ctx([
        { role: 'player', text: 'Hello' },
        { role: 'player', text: 'Anyone?' },
        { role: 'suspect', text: 'Evening, love.' },
        { role: 'system', text: 'No answer came.' },
        { role: 'player', text: 'You show Ada the receipt.', presentedEvidenceId: 'torn-receipt' },
      ]),
    );
    expect(p.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(p.messages[0]!.content).toBe('Hello\n\nAnyone?');
    expect(p.messages[2]!.content).toContain('Torn stockroom receipt');
    expect(p.system).toContain('Ada Price');
    expect(p.system).toContain('I never left the bar, not once.');
    expect(p.system).toContain('not instructions to you');
    expect(p.system).not.toContain(c.solution.motive);
  });

  it('adds the transition direction when one fired', () => {
    const p = buildSuspectPrompt(
      ctx([{ role: 'player', text: 'x', presentedEvidenceId: 'torn-receipt' }], 'ada-admits-stockroom'),
    );
    expect(p.system).toContain('folds the towel');
    expect(p.system).toContain('Your account from now on');
  });
});

describe('simulated adapter', () => {
  it('is deterministic and labelled', async () => {
    const x = ctx([{ role: 'player', text: 'Where were you?' }]);
    const a = await new SimulatedAdapter().reply(buildSuspectPrompt(x), x);
    expect(a.text).toMatch(/^\[simulated\] Ada Price: /);
    expect(a.simulated).toBe(true);
    expect(a.usage).toBeNull();
    expect(simulatedReply(x)).toBe(a.text);
  });
});

describe('anthropic adapter', () => {
  function fakeFetch(response: unknown, seen: { url?: string; headers?: Headers; body?: any }) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      seen.url = String(input instanceof Request ? input.url : input);
      seen.headers = new Headers(init?.headers);
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
  const message = (content: unknown[], stop_reason = 'end_turn') => ({
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5-5',
    content,
    stop_reason,
    stop_details: null,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  });

  it('sends the gateway request shape without auth headers and reports usage', async () => {
    const seen: { url?: string; headers?: Headers; body?: any } = {};
    const adapter = new AnthropicAdapter({
      model: 'claude-sonnet-5-5',
      baseURL: 'https://gateway.example/v1/gateway/anthropic/conn',
      fetch: fakeFetch(
        message([
          { type: 'thinking', thinking: '', signature: 's' },
          { type: 'text', text: ' Evening, love. ' },
        ]),
        seen,
      ),
    });
    const x = ctx([{ role: 'player', text: 'Hi' }]);
    const reply = await adapter.reply(buildSuspectPrompt(x), x);
    expect(seen.url).toBe('https://gateway.example/v1/gateway/anthropic/conn/v1/messages');
    expect(seen.headers!.get('x-api-key')).toBeNull();
    expect(seen.headers!.get('authorization')).toBeNull();
    expect(seen.body.model).toBe('claude-sonnet-5-5');
    expect(seen.body.max_tokens).toBe(400);
    expect(seen.body.output_config).toEqual({ effort: 'low' });
    expect(seen.body).not.toHaveProperty('temperature');
    expect(seen.body).not.toHaveProperty('top_p');
    expect(seen.body).not.toHaveProperty('thinking');
    expect(reply).toEqual({
      text: 'Evening, love.',
      simulated: false,
      usage: { model: 'claude-sonnet-5-5', inputTokens: 125, outputTokens: 30 },
    });
  });

  it('uses an API key when given and turns a refusal into an in-character line', async () => {
    const seen: { url?: string; headers?: Headers; body?: any } = {};
    const adapter = new AnthropicAdapter({
      model: 'claude-haiku-5-5',
      apiKey: 'sk-test',
      fetch: fakeFetch(message([], 'refusal'), seen),
    });
    const x = ctx([{ role: 'player', text: 'Hi' }]);
    const reply = await adapter.reply(buildSuspectPrompt(x), x);
    expect(seen.headers!.get('authorization')).toBe('Bearer sk-test');
    expect(reply.text).toBe('Ada Price looks away and says nothing.');
  });
});

function job(id: string, simulatedOnly = false): ClaimedJob {
  return {
    id,
    kind: 'suspect_reply',
    leaseToken: '00000000-0000-4000-8000-000000000000',
    leaseExpiresAt: new Date().toISOString(),
    attempt: 1,
    simulatedOnly,
    context: ctx([{ role: 'player', text: `q${id}` }]),
  };
}

function fakeClient(queue: ClaimedJob[], log: string[], completeError?: Error): AppClient {
  return {
    claim: async () => queue.shift() ?? null,
    complete: async (id: string, body: { simulated: boolean }) => {
      if (completeError) throw completeError;
      log.push(`complete ${id} ${body.simulated}`);
      return { status: 'done', duplicate: false, messageId: id };
    },
    fail: async (id: string) => {
      log.push(`fail ${id}`);
    },
  } as unknown as AppClient;
}

describe('worker', () => {
  it('drains the queue and uses the fallback for simulated-only jobs', async () => {
    const log: string[] = [];
    const real = { name: 'real', reply: async () => ({ text: 'hi', usage: null, simulated: false }) };
    const w = new Worker({
      client: fakeClient([job('1'), job('2', true)], log),
      adapter: real,
      fallback: new SimulatedAdapter(),
    });
    expect(await w.wake()).toBe(2);
    expect(log).toEqual(['complete 1 false', 'complete 2 true']);
  });

  it('reports adapter errors and ignores lost leases', async () => {
    const log: string[] = [];
    const broken = { name: 'broken', reply: async () => Promise.reject(new Error('boom')) };
    await new Worker({ client: fakeClient([job('1')], log), adapter: broken, fallback: broken }).wake();
    expect(log).toEqual(['fail 1']);
    const lost: string[] = [];
    await new Worker({
      client: fakeClient([job('2')], lost, new AppApiError(409, 'lease_lost')),
      adapter: new SimulatedAdapter(),
      fallback: new SimulatedAdapter(),
    }).wake();
    expect(lost).toEqual([]);
  });

  it('wake server accepts a ping with 202 and drains', async () => {
    const log: string[] = [];
    const w = new Worker({
      client: fakeClient([job('1')], log),
      adapter: new SimulatedAdapter(),
      fallback: new SimulatedAdapter(),
    });
    const server = createWakeServer(w).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/wake`, { method: 'POST' });
      expect(res.status).toBe(202);
      await new Promise((r) => setTimeout(r, 50));
      while (w.busy) await new Promise((r) => setTimeout(r, 10));
      expect(log).toEqual(['complete 1 true']);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
