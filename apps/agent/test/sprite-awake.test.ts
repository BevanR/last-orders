import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClaimedJob, CompleteJobResponse } from '@last-orders/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter, type AppClient, SimulatedAdapter, Worker } from '../src/index.js';
import { createWakeServer } from '../src/wake.js';

const message = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text: 'Well, well.' }],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 10, output_tokens: 3 },
};

async function listen(s: Server): Promise<string> {
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
});

describe('model call deadline (real sockets, undici fetch)', () => {
  it('cuts off a response body that stalls after the headers, retries once, and succeeds', async () => {
    let calls = 0;
    const gateway = createServer((req, res) => {
      req.resume();
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      // First request: headers and half a body, then nothing (the stall seen behind a suspend).
      if (calls === 1) res.write(JSON.stringify(message).slice(0, 20));
      else res.end(JSON.stringify(message));
    });
    servers.push(gateway);
    const logs: string[] = [];
    const adapter = new AnthropicAdapter({
      model: 'claude-sonnet-5-5',
      baseURL: await listen(gateway),
      timeoutMs: 300,
      log: (m) => logs.push(m),
    });
    const started = Date.now();
    const r = await adapter.commentary({ system: 's', user: 'u' }, {} as never);
    expect(r.text).toBe('Well, well.');
    expect(calls).toBe(2);
    expect(logs[0]).toMatch(/retrying on a fresh connection/);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('gives up within two attempts when every body stalls', async () => {
    let calls = 0;
    const gateway = createServer((req, res) => {
      req.resume();
      calls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"id":');
    });
    servers.push(gateway);
    const adapter = new AnthropicAdapter({ model: 'm', baseURL: await listen(gateway), timeoutMs: 200 });
    const started = Date.now();
    await expect(adapter.commentary({ system: 's', user: 'u' }, {} as never)).rejects.toThrow();
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('wake server keeps the request open while it works', () => {
  it('answers 202 at once, sends heartbeats, and ends the response only when the drain is done', async () => {
    let finish: (r: CompleteJobResponse) => void = () => {};
    const job: ClaimedJob = {
      id: '1',
      kind: 'reveal_commentary',
      leaseToken: 't',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      attempt: 1,
      simulatedOnly: true,
      context: {} as never,
    } as ClaimedJob;
    const queue = [job];
    const client = {
      claim: async () => queue.shift() ?? null,
      // The app call that completes the job is slow: the drain is still running meanwhile.
      complete: () => new Promise<CompleteJobResponse>((r) => (finish = r)),
      fail: async () => {},
    } as unknown as AppClient;
    const worker = new Worker({ client, adapter: new SimulatedAdapter(), fallback: new SimulatedAdapter() });
    // The model step is not under test here.
    worker.run = async () => ({ output: { text: 'x' }, simulated: true, usage: null });
    const wake = createWakeServer(worker, () => {}, { heartbeatMs: 20 });
    servers.push(wake);
    const base = await listen(wake);

    const res = await fetch(`${base}/wake`, { method: 'POST' });
    expect(res.status).toBe(202);
    const body = res.text();
    let ended = false;
    void body.then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 100));
    expect(worker.busy).toBe(true);
    expect(ended).toBe(false);

    finish({ messageId: null } as unknown as CompleteJobResponse);
    const text = await body;
    expect(text.startsWith('accepted\n')).toBe(true);
    expect(text).toContain('working\n');
    expect(text.endsWith('done 1\n')).toBe(true);
    expect(worker.busy).toBe(false);
  });
});
