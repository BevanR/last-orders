import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { AppClient, SimulatedAdapter, Worker } from '@last-orders/agent';
import { buildApp, type AppContext } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/last_orders_test';
export const SECRET = 'test-secret';
export const FIXTURE_CASE = fileURLToPath(
  new URL('../../../packages/engine/test/fixtures/fixture.case.json', import.meta.url),
);
export const REAL_CASE = fileURLToPath(new URL('../../../case/last-orders.case.json', import.meta.url));

export interface TestServer extends AppContext {
  config: Config;
  baseUrl: string;
  worker: Worker;
  close: () => Promise<void>;
}

/** Start the app on a random port against a clean test database, with an in-process agent. */
export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const config: Config = {
    ...loadConfig({}),
    databaseUrl: TEST_DATABASE_URL,
    agentSharedSecret: SECRET,
    agentWakeUrl: '',
    cookieSecure: false,
    webDist: '/nonexistent',
    caseFile: FIXTURE_CASE,
    ...overrides,
  };
  const ctx = await buildApp(config, { startDispatcher: false });
  await ctx.db.query('TRUNCATE games RESTART IDENTITY CASCADE');
  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (ctx.app.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const simulated = new SimulatedAdapter();
  const worker = new Worker({ client: new AppClient(baseUrl, SECRET), adapter: simulated, fallback: simulated });
  return { ...ctx, config, baseUrl, worker, close: () => ctx.app.close() };
}

export interface Res<T = any> {
  status: number;
  body: T;
}

/** A browser stand-in with its own cookie. */
export class Player {
  cookie = '';
  roomCode = '';
  /** Every response body this player received, as text, in order. */
  readonly log: string[] = [];

  constructor(readonly baseUrl: string) {}

  async req<T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    this.log.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  room(path: string) {
    return `/api/rooms/${this.roomCode}${path}`;
  }

  state() {
    return this.req('GET', this.room('/state'));
  }
  inspect(locationId: string, actionId: string) {
    return this.req('POST', this.room('/inspect'), { locationId, actionId });
  }
  accuse(suspectId: string, evidenceIds: string[], reasoning = '') {
    return this.req('POST', this.room('/accuse'), { suspectId, evidenceIds, reasoning });
  }
  advance() {
    return this.req('POST', this.room('/advance'));
  }
  end() {
    return this.req('POST', this.room('/end'));
  }
  hint() {
    return this.req('POST', this.room('/hint'));
  }
  share(evidenceId: string) {
    return this.req('POST', this.room('/share'), { evidenceId });
  }
  say(suspectId: string, text: string) {
    return this.req('POST', this.room(`/interviews/${suspectId}/messages`), { text });
  }
  present(suspectId: string, evidenceId: string) {
    return this.req('POST', this.room(`/interviews/${suspectId}/present`), { evidenceId });
  }
  interview(suspectId: string) {
    return this.req('GET', this.room(`/interviews/${suspectId}`));
  }
}

export async function createRoom(baseUrl: string, name = 'Host') {
  const host = new Player(baseUrl);
  const r = await host.req('POST', '/api/rooms', { displayName: name });
  if (r.status !== 200) throw new Error(`create room failed: ${JSON.stringify(r)}`);
  host.roomCode = r.body.roomCode;
  return { host, hostUrl: r.body.hostUrl as string };
}

export async function joinRoom(baseUrl: string, roomCode: string, name: string) {
  const p = new Player(baseUrl);
  p.roomCode = roomCode;
  const r = await p.req('POST', `/api/rooms/${roomCode}/join`, { displayName: name });
  if (r.status !== 200) throw new Error(`join failed: ${JSON.stringify(r)}`);
  return p;
}

/** Create a room with `n` players (the first is host) and start the game. */
export async function startedGame(baseUrl: string, names: string[] = ['Alice', 'Bob']) {
  const { host } = await createRoom(baseUrl, names[0]);
  const others = [];
  for (const n of names.slice(1)) others.push(await joinRoom(baseUrl, host.roomCode, n));
  const s = await host.req('POST', host.room('/start'));
  if (s.status !== 200) throw new Error(`start failed: ${JSON.stringify(s)}`);
  return [host, ...others];
}

export interface SseEvent {
  id: number;
  type: string;
  payload: any;
}

/**
 * Open the SSE stream as a player and collect events until `until` returns true or the timeout
 * passes. Returns what arrived.
 */
export function openSse(player: Player, lastEventId = 0) {
  const events: SseEvent[] = [];
  const ac = new AbortController();
  const ready = (async () => {
    const res = await fetch(player.baseUrl + player.room('/events'), {
      headers: { cookie: player.cookie, 'last-event-id': String(lastEventId) },
      signal: ac.signal,
    });
    if (res.status !== 200) throw new Error(`sse status ${res.status}`);
    return res;
  })();
  const done = (async () => {
    const res = await ready;
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) return;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (\d+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (id && data) {
            const parsed = JSON.parse(data) as { type: string; payload: unknown };
            events.push({ id: Number(id), type: parsed.type, payload: parsed.payload });
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    events,
    ready,
    async waitFor(pred: (e: SseEvent[]) => boolean, timeoutMs = 5_000) {
      const start = Date.now();
      while (!pred(events)) {
        if (Date.now() - start > timeoutMs)
          throw new Error(`timed out; got ${JSON.stringify(events.map((e) => e.type))}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return events;
    },
    async close() {
      ac.abort();
      await done;
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
