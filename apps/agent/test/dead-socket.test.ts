import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicAdapter, AppClient } from '../src/index.js';

/**
 * Regression test with real sockets for the hang seen after a Sprite suspend/resume: pooled
 * keep-alive connections that still look open but never answer. `suspend()` turns every
 * connection open at that moment into a black hole (requests are read, never answered, the
 * socket is never closed), so a client that reuses a pooled socket hangs. Connections opened
 * afterwards are answered normally.
 */
function suspendableServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const open = new Set<Socket>();
  const dead = new Set<Socket>();
  const log: Array<{ port: number; answered: boolean }> = [];
  const server = createServer((req, res) => {
    const answered = !dead.has(req.socket);
    log.push({ port: req.socket.remotePort!, answered });
    req.resume();
    if (answered) req.on('end', () => handler(req, res));
  });
  server.on('connection', (sock: Socket) => {
    open.add(sock);
    sock.on('close', () => open.delete(sock));
  });
  const suspend = () => {
    for (const sock of open) dead.add(sock);
    return [...open].map((sock) => sock.remotePort!);
  };
  return { server, log, suspend };
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Idle time before the suspend: lets the client return its socket to the keep-alive pool. */
const idle = () => new Promise((r) => setTimeout(r, 50));

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

describe('dead pooled socket (real sockets)', () => {
  it('AppClient: the request on the dead pooled socket times out and the retry on a new connection succeeds', async () => {
    const h = suspendableServer((_req, res) => {
      res.statusCode = 204;
      res.end();
    });
    server = h.server;
    const logs: string[] = [];
    const client = new AppClient(await listen(server), 's', undefined, { timeoutMs: 300, log: (m) => logs.push(m) });

    await expect(client.claim()).resolves.toBeNull(); // fills the keep-alive pool
    await idle();
    const pooled = h.suspend();
    expect(pooled.length).toBeGreaterThan(0);
    const started = Date.now();
    await expect(client.claim()).resolves.toBeNull(); // reuses a dead socket (hangs), then retries
    const took = Date.now() - started;

    const after = h.log.slice(1);
    expect(after).toHaveLength(2);
    expect(after[0]!.answered).toBe(false);
    expect(pooled).toContain(after[0]!.port); // the first attempt went over the pooled socket
    expect(after[1]!.answered).toBe(true);
    expect(pooled).not.toContain(after[1]!.port); // the retry went over a fresh connection
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1_500);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/timeout/i);
  });

  it('AnthropicAdapter: the same against a fake /v1/messages endpoint', async () => {
    const paths: string[] = [];
    const h = suspendableServer((req, res) => {
      paths.push(req.url!);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [{ type: 'text', text: 'Evening.' }],
          stop_reason: 'end_turn',
          stop_details: null,
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    });
    server = h.server;
    const logs: string[] = [];
    const adapter = new AnthropicAdapter({
      model: 'claude-haiku-5-5',
      baseURL: await listen(server),
      timeoutMs: 300,
      log: (m) => logs.push(m),
    });
    const prompt = { system: 's', user: 'u' };

    expect((await adapter.commentary(prompt, {} as never)).text).toBe('Evening.');
    await idle();
    const pooled = h.suspend();
    expect(pooled.length).toBeGreaterThan(0);
    expect((await adapter.commentary(prompt, {} as never)).text).toBe('Evening.');

    expect(paths).toEqual(['/v1/messages', '/v1/messages']);
    const after = h.log.slice(1);
    expect(after.map((l) => l.answered)).toEqual([false, true]);
    expect(pooled).toContain(after[0]!.port);
    expect(pooled).not.toContain(after[1]!.port);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/timed out/i);
  });
});
