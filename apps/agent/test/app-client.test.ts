import type { Dispatcher } from 'undici';
import { describe, expect, it } from 'vitest';
import { AppApiError, AppClient } from '../src/index.js';

/** A stand-in dispatcher that records whether it was destroyed. */
function fakeDispatcher(id: number) {
  const d = {
    id,
    destroyed: false,
    destroy: () => {
      d.destroyed = true;
      return Promise.resolve();
    },
  };
  return d;
}
type FakeDispatcher = ReturnType<typeof fakeDispatcher>;

/** AppClient whose fetch answers from `steps` in order and records the dispatcher of each call. */
function setup(steps: Array<() => Promise<Response>>) {
  const dispatchers: FakeDispatcher[] = [];
  const used: FakeDispatcher[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (_url: URL, init?: RequestInit & { dispatcher?: FakeDispatcher }) => {
    used.push(init!.dispatcher!);
    const step = steps.shift();
    if (!step) throw new Error('unexpected extra request');
    return step();
  }) as unknown as typeof fetch;
  const client = new AppClient('http://app.test', 'secret', fetchImpl, {
    timeoutMs: 50,
    createDispatcher: () => {
      const d = fakeDispatcher(dispatchers.length);
      dispatchers.push(d);
      return d as unknown as Dispatcher;
    },
    log: (m) => logs.push(m),
  });
  return { client, dispatchers, used, logs };
}

const networkError = () => Promise.reject(new TypeError('fetch failed'));
const timeout = () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
const json = (status: number, body: unknown) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

describe('AppClient connection recovery', () => {
  it('retries a timed-out request once on a fresh dispatcher and succeeds', async () => {
    const { client, dispatchers, used, logs } = setup([
      timeout,
      () => Promise.resolve(new Response(null, { status: 204 })),
    ]);
    await expect(client.claim()).resolves.toBeNull();
    expect(used.map((d) => d.id)).toEqual([0, 1]);
    expect(dispatchers[0]!.destroyed).toBe(true);
    expect(dispatchers[1]!.destroyed).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/retrying on a fresh connection/);
  });

  it('retries a network error once on a fresh dispatcher and succeeds', async () => {
    const { client, used, dispatchers } = setup([networkError, json(200, { status: 'applied' })]);
    await expect(
      client.complete('j1', { leaseToken: 't', output: { text: 'hi' }, simulated: true } as never),
    ).resolves.toEqual({
      status: 'applied',
    });
    expect(used.map((d) => d.id)).toEqual([0, 1]);
    expect(dispatchers[0]!.destroyed).toBe(true);
  });

  it('aborts a hanging request at the per-attempt timeout and retries it', async () => {
    const used: unknown[] = [];
    let first = true;
    // Like a request written to a dead keep-alive socket: never answers until the signal fires.
    const fetchImpl = ((_url: URL, init?: RequestInit & { dispatcher?: unknown }) => {
      used.push(init!.dispatcher);
      if (first) {
        first = false;
        return new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason)),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
    const client = new AppClient('http://app.test', 'secret', fetchImpl, { timeoutMs: 20 });
    await expect(client.claim()).resolves.toBeNull();
    expect(used).toHaveLength(2);
    expect(used[0]).toBeTruthy();
    expect(used[1]).not.toBe(used[0]);
  });

  it('does not retry an HTTP error response', async () => {
    const { client, used, dispatchers } = setup([json(401, { error: 'unauthorized' })]);
    const err = await client.claim().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppApiError);
    expect((err as AppApiError).status).toBe(401);
    expect(used).toHaveLength(1);
    expect(dispatchers).toHaveLength(1);
    expect(dispatchers[0]!.destroyed).toBe(false);
  });

  it('surfaces the error when the retry also fails', async () => {
    const { client, used } = setup([networkError, networkError]);
    await expect(client.claim()).rejects.toThrow('fetch failed');
    expect(used.map((d) => d.id)).toEqual([0, 1]);
  });
});
