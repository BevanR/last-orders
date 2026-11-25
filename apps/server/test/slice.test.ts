import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppClient } from '@last-orders/agent';
import { Dispatcher } from '../src/dispatcher.js';
import {
  createRoom,
  joinRoom,
  openSse,
  Player,
  SECRET,
  sleep,
  startedGame,
  startServer,
  type TestServer,
} from './helpers.js';

let srv: TestServer;

beforeEach(async () => {
  srv = await startServer();
});
afterEach(async () => {
  await srv.close();
});

async function count(sql: string, params: unknown[] = []) {
  const { rows } = await srv.db.query<{ n: string }>(sql, params);
  return Number(rows[0]!.n);
}

describe('vertical slice', () => {
  it('runs the full flow: join, interview, inspect, share live, present, testimony changes once', async () => {
    const { host: alice, hostUrl } = await createRoom(srv.baseUrl, 'Alice');
    const bob = await joinRoom(srv.baseUrl, alice.roomCode, 'Bob');
    expect(hostUrl).toMatch(/^\/h\/[A-Za-z0-9_-]{40,}$/);

    // Lobby: no locations, host controls only for the host.
    const lobby = await bob.state();
    expect(lobby.body.status).toBe('lobby');
    expect(lobby.body.players.map((p: any) => p.name)).toEqual(['Alice', 'Bob']);
    expect(lobby.body.host).toBeUndefined();
    expect((await bob.req('POST', bob.room('/start'))).status).toBe(403);
    expect((await alice.req('POST', alice.room('/start'))).status).toBe(200);

    // Private interview with a simulated reply.
    expect((await alice.say('ada', 'Where were you at ten?')).status).toBe(200);
    expect((await alice.say('ada', 'And again?')).status).toBe(409); // wait for the reply
    expect(await srv.worker.wake()).toBe(1);
    const first = await alice.interview('ada');
    expect(first.body.messages.map((m: any) => m.role)).toEqual(['player', 'suspect']);
    expect(first.body.messages[1].text).toMatch(/^\[simulated\] Ada Price: /);
    expect(first.body.messages[1].simulated).toBe(true);
    expect(first.body.waiting).toBe(false);

    // Inspect and discover.
    const found = await alice.inspect('bar');
    expect(found.body.found.map((e: any) => e.id)).toEqual(['torn-receipt']);
    expect((await alice.inspect('cellar')).status).toBe(403);
    expect((await bob.state()).body.notebook).toEqual([]);

    // Share: Bob sees it live over SSE.
    const bobBefore = await bob.state();
    const sse = openSse(bob);
    await sse.ready;
    await sleep(50);
    expect((await alice.share('torn-receipt')).status).toBe(200);
    const live = await sse.waitFor((ev) => ev.some((e) => e.type === 'board_item'));
    expect(live.find((e) => e.type === 'board_item')!.payload).toMatchObject({
      evidence: { id: 'torn-receipt' },
      sharedBy: 'Alice',
    });
    expect(bobBefore.body.board).toEqual([]);
    expect((await bob.state()).body.board.map((e: any) => e.id)).toEqual(['torn-receipt']);

    // Bob presents the card: the transition fires.
    expect((await bob.present('ada', 'torn-receipt')).status).toBe(200);
    await sse.waitFor((ev) => ev.filter((e) => e.type === 'message').length >= 1);
    await srv.worker.wake();
    const shaken = await bob.interview('ada');
    expect(shaken.body.messages[0].presentedEvidenceId).toBe('torn-receipt');
    expect(shaken.body.messages[1].text).toContain('stockroom');
    await sse.close();

    // Presenting again does nothing new.
    expect((await bob.present('ada', 'torn-receipt')).status).toBe(200);
    await srv.worker.wake();
    expect((await bob.interview('ada')).body.messages[3].text).toContain('means nothing');
    expect(await count('SELECT count(*) AS n FROM testimony_transitions')).toBe(1);

    // The new testimony persists in Alice's later interview.
    expect((await alice.say('ada', 'Tell me again where you were.')).status).toBe(200);
    await srv.worker.wake();
    const later = (await alice.interview('ada')).body.messages.at(-1).text;
    expect(
      ['I went to the stockroom just after ten.', 'I heard two men arguing in the cellar.'].some((f) =>
        later.includes(f),
      ),
    ).toBe(true);

    // The browser never receives testimony state ids, transition ids or the solution.
    const json = JSON.stringify((await bob.state()).body);
    for (const hidden of ['shaken', 'guarded', 'ada-admits-stockroom', 'solution', 'owed the landlord'])
      expect(json).not.toContain(hidden);
  });

  it('exchanges a host link for a host session', async () => {
    const { host, hostUrl } = await createRoom(srv.baseUrl, 'Alice');
    const other = new Player(srv.baseUrl);
    const r = await other.req('POST', '/api/host/claim', { hostToken: hostUrl.slice(3) });
    expect(r.body).toEqual({ roomCode: host.roomCode });
    other.roomCode = host.roomCode;
    expect((await other.state()).body.host).toEqual({ canStart: true, canAdvance: false, nextAct: null });
    expect((await other.req('POST', '/api/host/claim', { hostToken: 'x'.repeat(43) })).status).toBe(404);
  });

  it('lets the host advance acts and rejects non-members', async () => {
    const [alice, bob] = await startedGame(srv.baseUrl);
    expect((await bob!.req('POST', bob!.room('/advance'))).status).toBe(403);
    expect((await alice!.req('POST', alice!.room('/advance'))).status).toBe(200);
    expect((await alice!.state()).body.act.number).toBe(2);
    expect((await alice!.req('POST', alice!.room('/advance'))).status).toBe(409);

    const stranger = new Player(srv.baseUrl);
    stranger.roomCode = alice!.roomCode;
    expect((await stranger.state()).status).toBe(401);
    const { host: elsewhere } = await createRoom(srv.baseUrl, 'Eve');
    elsewhere.roomCode = alice!.roomCode;
    expect((await elsewhere.state()).status).toBe(403);
  });
});

describe('privacy', () => {
  it('does not leak interview messages between players', async () => {
    const [alice, bob] = await startedGame(srv.baseUrl);
    await alice!.say('ada', 'ALICE-SECRET-QUESTION');
    await bob!.say('ada', 'BOB-QUESTION');
    await srv.worker.wake();

    const a = (await alice!.interview('ada')).body.messages;
    const b = (await bob!.interview('ada')).body.messages;
    expect(a.map((m: any) => m.role)).toEqual(['player', 'suspect']);
    expect(b.map((m: any) => m.role)).toEqual(['player', 'suspect']);
    expect(JSON.stringify(b)).not.toContain('ALICE-SECRET-QUESTION');
    expect(JSON.stringify(a)).not.toContain('BOB-QUESTION');

    // Alice's message never reaches Bob's prompt either.
    await bob!.say('ada', 'again');
    const job = await new AppClient(srv.baseUrl, SECRET).claim();
    expect(JSON.stringify(job!.context)).not.toContain('ALICE-SECRET-QUESTION');
    expect(job!.context.history.map((h) => h.text)).toContain('BOB-QUESTION');
  });

  it('replays SSE from Last-Event-ID with only events the viewer may see', async () => {
    const [alice, bob] = await startedGame(srv.baseUrl);
    await alice!.say('ada', 'ALICE-PRIVATE');
    await alice!.inspect('bar');
    await bob!.say('bram', 'BOB-PRIVATE');
    await srv.worker.wake();
    await alice!.share('torn-receipt');

    const all = openSse(bob!);
    const events = await all.waitFor((ev) => ev.some((e) => e.type === 'board_item'));
    await sleep(100);
    await all.close();
    const raw = JSON.stringify(events);
    expect(raw).not.toContain('ALICE-PRIVATE');
    expect(events.some((e) => e.type === 'discovered')).toBe(false); // Alice's find is private
    expect(raw).toContain('BOB-PRIVATE');
    expect(events.map((e) => e.type)).toEqual([
      'player_joined',
      'player_joined',
      'game_started',
      'message',
      'message',
      'board_item',
    ]);
    const ids = events.map((e) => e.id);
    expect([...ids].sort((x, y) => x - y)).toEqual(ids);

    // Resume from the middle: only later events.
    const cursor = events[3]!.id;
    const resumed = openSse(bob!, cursor);
    const later = await resumed.waitFor((ev) => ev.some((e) => e.type === 'board_item'));
    await sleep(100);
    await resumed.close();
    expect(later.map((e) => e.type)).toEqual(['message', 'board_item']);
    expect(later.every((e) => e.id > cursor)).toBe(true);

    // Alice sees her own private events.
    const mine = openSse(alice!);
    const aliceEvents = await mine.waitFor((ev) => ev.some((e) => e.type === 'board_item'));
    await mine.close();
    expect(aliceEvents.some((e) => e.type === 'discovered')).toBe(true);
    expect(JSON.stringify(aliceEvents)).not.toContain('BOB-PRIVATE');
  });
});

describe('testimony transitions', () => {
  it('fire exactly once under concurrent presents', async () => {
    const players = await startedGame(srv.baseUrl, ['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
    await players[0]!.inspect('bar');
    await players[0]!.share('torn-receipt');
    const results = await Promise.all(players.map((p) => p.present('ada', 'torn-receipt')));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await count('SELECT count(*) AS n FROM testimony_transitions')).toBe(1);
    const { rows } = await srv.db.query("SELECT state, revision FROM suspect_states WHERE suspect_id = 'ada'");
    expect(rows[0]).toEqual({ state: 'shaken', revision: 1 });
    expect(await count("SELECT count(*) AS n FROM jobs WHERE payload->>'transitionId' IS NOT NULL")).toBe(1);

    await srv.worker.wake();
    const replies = await Promise.all(
      players.map(async (p) => (await p.interview('ada')).body.messages[1].text as string),
    );
    expect(replies.filter((t) => t.includes('folds the towel'))).toHaveLength(1);
  });

  it('requeues a reply built from stale testimony', async () => {
    const [alice, bob] = await startedGame(srv.baseUrl);
    const agent = new AppClient(srv.baseUrl, SECRET);
    await alice!.say('ada', 'Where were you?');
    const job = (await agent.claim())!;
    expect(job.context.testimony.state).toBe('guarded');

    await alice!.inspect('bar');
    await alice!.share('torn-receipt');
    await bob!.present('ada', 'torn-receipt');

    const r = await agent.complete(job.id, {
      leaseToken: job.leaseToken,
      output: { text: 'old answer' },
      simulated: true,
      usage: null,
    });
    expect(r).toEqual({ status: 'requeued', reason: 'stale' });
    const again = (await agent.claim())!;
    expect(again.id).toBe(job.id);
    expect(again.context.testimony.state).toBe('shaken');
  });
});

describe('jobs', () => {
  it('completing a job twice does not duplicate messages', async () => {
    const [alice] = await startedGame(srv.baseUrl);
    const sse = openSse(alice!);
    await alice!.say('ada', 'Hello?');
    const agent = new AppClient(srv.baseUrl, SECRET);
    const job = (await agent.claim())!;
    const body = { leaseToken: job.leaseToken, output: { text: 'Evening.' }, simulated: true, usage: null };
    const [one, two] = await Promise.all([agent.complete(job.id, body), agent.complete(job.id, body)]);
    const three = await agent.complete(job.id, body);
    expect([one, two, three].filter((r) => r.status === 'done' && !r.duplicate)).toHaveLength(1);
    expect(three).toMatchObject({ status: 'done', duplicate: true });
    expect(await count('SELECT count(*) AS n FROM messages WHERE job_id = $1', [job.id])).toBe(1);
    await sleep(200);
    await sse.close();
    expect(sse.events.filter((e) => e.type === 'message' && e.payload.message.role === 'suspect')).toHaveLength(1);
  });

  it('requeues an expired lease and rejects the old lease holder', async () => {
    const [alice] = await startedGame(srv.baseUrl);
    await alice!.say('ada', 'Hello?');
    const agent = new AppClient(srv.baseUrl, SECRET);
    const job = (await agent.claim())!;
    expect(await agent.claim()).toBeNull(); // nothing else pending
    await srv.db.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);

    const tick = await srv.dispatcher.tick();
    expect(tick).toMatchObject({ requeued: 1, pending: 1 });
    await expect(
      agent.complete(job.id, { leaseToken: job.leaseToken, output: { text: 'late' }, simulated: true, usage: null }),
    ).rejects.toMatchObject({ status: 409 });

    const retry = (await agent.claim())!;
    expect(retry.id).toBe(job.id);
    expect(retry.attempt).toBe(2);
    expect(retry.leaseToken).not.toBe(job.leaseToken);
    await agent.complete(retry.id, {
      leaseToken: retry.leaseToken,
      output: { text: 'on time' },
      simulated: true,
      usage: null,
    });
    expect((await alice!.interview('ada')).body.messages.at(-1).text).toBe('on time');
  });

  it('fails a job with a visible notice once attempts run out', async () => {
    const [alice] = await startedGame(srv.baseUrl);
    await alice!.say('ada', 'Hello?');
    const agent = new AppClient(srv.baseUrl, SECRET);
    for (let i = 0; i < 3; i++) {
      const job = (await agent.claim())!;
      await agent.fail(job.id, { leaseToken: job.leaseToken, error: 'model down' });
    }
    expect(await agent.claim()).toBeNull();
    const msgs = (await alice!.interview('ada')).body;
    expect(msgs.messages.at(-1)).toMatchObject({ role: 'system', text: 'No answer came. Try asking again.' });
    expect(msgs.waiting).toBe(false);
  });

  it('serialises replies per suspect', async () => {
    const [alice, bob] = await startedGame(srv.baseUrl);
    await alice!.say('ada', 'one');
    await bob!.say('ada', 'two');
    await bob!.say('bram', 'three');
    const agent = new AppClient(srv.baseUrl, SECRET);
    const a = (await agent.claim())!;
    const b = (await agent.claim())!;
    expect(a.context.suspect.id).toBe('ada');
    expect(b.context.suspect.id).toBe('bram');
    expect(await agent.claim()).toBeNull(); // Bob's ada job waits for Alice's
  });

  it('switches a game over its spend cap to simulated replies and records usage', async () => {
    const [alice] = await startedGame(srv.baseUrl);
    const agent = new AppClient(srv.baseUrl, SECRET);
    await alice!.say('ada', 'Hello?');
    const job = (await agent.claim())!;
    expect(job.simulatedOnly).toBe(false);
    await agent.complete(job.id, {
      leaseToken: job.leaseToken,
      output: { text: 'Evening.' },
      simulated: false,
      usage: { model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 100_000 },
    });
    const { rows } = await srv.db.query('SELECT spend_cents FROM games');
    expect(Number(rows[0].spend_cents)).toBe(300);
    await alice!.say('ada', 'Again?');
    expect((await agent.claim())!.simulatedOnly).toBe(true);
  });

  it('rejects the agent API without the shared secret', async () => {
    const bad = new AppClient(srv.baseUrl, 'wrong-secret');
    await expect(bad.claim()).rejects.toMatchObject({ status: 401 });
    const res = await fetch(`${srv.baseUrl}/internal/agent/jobs/claim`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('dispatcher', () => {
  it('pings the wake URL while jobs are pending, with backoff, and skips when unset', async () => {
    const [alice] = await startedGame(srv.baseUrl);
    let now = 0;
    const pings: string[] = [];
    const fakeFetch = (async (url: string | URL | Request) => {
      pings.push(String(url));
      return new Response(null, { status: 202 });
    }) as typeof fetch;
    const d = new Dispatcher(srv.jobs, {
      wakeUrl: 'http://agent.test/wake',
      intervalMs: 1_000,
      fetch: fakeFetch,
      now: () => now,
    });
    expect(await d.tick()).toMatchObject({ pending: 0, pinged: false });

    await alice!.say('ada', 'Hello?');
    expect((await d.tick()).pinged).toBe(true);
    expect((await d.tick()).pinged).toBe(false); // backing off (1s)
    now = 1_000;
    expect((await d.tick()).pinged).toBe(true);
    now = 2_000;
    expect((await d.tick()).pinged).toBe(false); // backing off (2s)
    now = 3_000;
    expect((await d.tick()).pinged).toBe(true);
    expect(pings).toEqual(['http://agent.test/wake', 'http://agent.test/wake', 'http://agent.test/wake']);

    await srv.worker.wake();
    expect(await d.tick()).toMatchObject({ pending: 0, pinged: false });

    await alice!.say('ada', 'More?');
    const unset = new Dispatcher(srv.jobs, { wakeUrl: '', intervalMs: 1_000, fetch: fakeFetch });
    expect(await unset.tick()).toMatchObject({ pending: 1, pinged: false });
    expect(pings).toHaveLength(3);
  });

  it('wakes a real agent endpoint when a player acts', async () => {
    const { createServer } = await import('node:http');
    let woken = 0;
    const agent = createServer((_req, res) => {
      woken++;
      void srv.worker.wake();
      res.writeHead(202).end();
    }).listen(0, '127.0.0.1');
    await new Promise((r) => agent.once('listening', r));
    const port = (agent.address() as { port: number }).port;
    await srv.close();
    srv = await startServer({ agentWakeUrl: `http://127.0.0.1:${port}/wake` });
    try {
      const [alice] = await startedGame(srv.baseUrl);
      await alice!.say('ada', 'Hello?');
      for (let i = 0; i < 100 && (await alice!.interview('ada')).body.messages.length < 2; i++) await sleep(20);
      expect(woken).toBeGreaterThanOrEqual(1);
      expect((await alice!.interview('ada')).body.messages).toHaveLength(2);
    } finally {
      agent.close();
    }
  });
});
