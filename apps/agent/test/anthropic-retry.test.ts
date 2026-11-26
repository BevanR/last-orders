import type { Dispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../src/index.js';

const message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text: 'Well, well.' }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 3 },
};
const prompt = { system: 's', user: 'u' };

/** Adapter whose transport answers from `steps` in order, recording each call's dispatcher. */
function setup(steps: Array<() => Promise<Response>>) {
  const dispatchers: Array<{ id: number; destroyed: boolean }> = [];
  const used: number[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit & { dispatcher?: { id: number } }) => {
    used.push(init!.dispatcher!.id);
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    return step();
  }) as unknown as typeof fetch;
  const adapter = new AnthropicAdapter({
    model: 'claude-haiku-5-5',
    baseURL: 'http://gateway.test',
    fetch: fetchImpl,
    createDispatcher: () => {
      const d = {
        id: dispatchers.length,
        destroyed: false,
        destroy: () => ((d.destroyed = true), Promise.resolve()),
      };
      dispatchers.push(d);
      return d as unknown as Dispatcher;
    },
    log: (m) => logs.push(m),
  });
  return { adapter, dispatchers, used, logs };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }),
    );
const networkError = () => Promise.reject(new TypeError('fetch failed'));

describe('anthropic adapter connection recovery', () => {
  it('retries a network error once on a fresh dispatcher and succeeds', async () => {
    const { adapter, dispatchers, used, logs } = setup([networkError, json(200, message)]);
    const r = await adapter.commentary(prompt, {} as never);
    expect(r.text).toBe('Well, well.');
    expect(used).toEqual([0, 1]);
    expect(dispatchers[0]!.destroyed).toBe(true);
    expect(logs[0]).toMatch(/retrying on a fresh connection/);
  });

  it('surfaces the error when the retry also fails', async () => {
    const { adapter, used } = setup([networkError, networkError]);
    await expect(adapter.commentary(prompt, {} as never)).rejects.toThrow(/Connection error/);
    expect(used).toEqual([0, 1]);
  });

  it.each([
    [500, { 'x-should-retry': 'true' }],
    [429, { 'retry-after': '0' }],
    [529, {}],
    [408, {}],
  ])('does not retry an HTTP %i from the gateway (exactly one request)', async (status, headers) => {
    const { adapter, used, dispatchers } = setup([
      json(status, { type: 'error', error: { type: 'api_error', message: 'nope' } }, headers),
    ]);
    const err = (await adapter.commentary(prompt, {} as never).catch((e: unknown) => e)) as { status?: number };
    expect(err.status).toBe(status);
    expect(used).toEqual([0]);
    expect(dispatchers[0]!.destroyed).toBe(false);
  });
});
