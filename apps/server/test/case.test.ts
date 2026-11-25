import { readFileSync } from 'node:fs';
import { AppClient } from '@last-orders/agent';
import { parseCase } from '@last-orders/engine';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSse,
  REAL_CASE,
  SECRET,
  sleep,
  startedGame,
  startServer,
  type Player,
  type TestServer,
} from './helpers.js';

const c = parseCase(JSON.parse(readFileSync(REAL_CASE, 'utf8')));

/** Strings that identify the killer or the verdict. None may reach a browser before the reveal. */
const SOLUTION_STRINGS = [
  c.solution.summary,
  c.solution.motive,
  c.solution.method,
  c.solution.narration,
  ...c.solution.clues.map((k) => k.text),
  ...c.accusation.outcomes.flatMap((o) => [o.text, `"${o.id}"`]),
  ...c.red_herrings.map((r) => r.text),
  'Lionel Fitch killed',
  'killer',
  '"verdict"',
  '"reveal"',
];

let srv: TestServer;
afterEach(async () => {
  await srv?.close();
});

/** Ask a suspect something and wait for the simulated reply. */
async function talk(p: Player, suspectId: string, text: string) {
  expect((await p.say(suspectId, text)).status).toBe(200);
  await srv.worker.wake();
  return (await p.interview(suspectId)).body.messages.at(-1).text as string;
}

async function show(p: Player, suspectId: string, evidenceId: string) {
  const r = await p.present(suspectId, evidenceId);
  expect(r.status).toBe(200);
  await srv.worker.wake();
  return (await p.interview(suspectId)).body.messages.at(-1).text as string;
}

async function found(p: Player, locationId: string, actionId: string) {
  const r = await p.inspect(locationId, actionId);
  expect(r.status).toBe(200);
  return r.body.found.map((e: { id: string }) => e.id) as string[];
}

function expectNoSolution(texts: string[]) {
  const all = texts.join('\n');
  for (const s of SOLUTION_STRINGS) expect(all, `leaked: ${s.slice(0, 60)}`).not.toContain(s);
}

describe('the full case, end to end with the simulated agent', () => {
  it('plays the bible §14 sequence to a clean "solved" reveal, with nothing leaked before it', async () => {
    srv = await startServer({ caseFile: REAL_CASE, gmTickSeconds: 0.001 });
    const [host, guest] = await startedGame(srv.baseUrl, ['Hana', 'Rawiri']);
    const hostSse = openSse(host!);
    const guestSse = openSse(guest!);
    await Promise.all([hostSse.ready, guestSse.ready]);

    // 1. First accounts from three suspects, split across the two players.
    expect(await talk(host!, 'lionel', 'Tell us about tonight.')).toContain(
      'I went out to my car for my blood-pressure pills',
    );
    expect(await talk(guest!, 'dougal', 'What happened?')).toContain('took a whisky into the lounge');
    expect(await talk(guest!, 'tessa', 'Hello.')).toContain('downstairs loo');
    expect((await host!.state()).body.act.number).toBe(1);

    // 2-3. The camera and the foot of the stairs: Act II starts on its own.
    expect(await found(host!, 'dining-room', 'camera')).toEqual(['e3']);
    expect(await found(guest!, 'wine-cellar', 'foot-of-stairs')).toEqual(['e1']);
    const act2 = (await guest!.state()).body;
    expect(act2.act).toMatchObject({ number: 2, name: 'Contradictions' });
    expect(act2.locations.map((l: { id: string }) => l.id)).toEqual([
      'dining-room',
      'wine-cellar',
      'kitchen',
      'office',
      'boot-room',
    ]);

    // 4. The storm hatch opens the Woodshed.
    expect(await found(host!, 'wine-cellar', 'storm-hatch')).toEqual(['e2']);
    expect((await host!.state()).body.locations.map((l: { id: string }) => l.id)).toContain('woodshed');
    // 5. The boot room. 6. The woodpile.
    expect(await found(guest!, 'boot-room', 'shoe-rack')).toEqual(['e7']);
    expect(await found(host!, 'woodshed', 'woodpile')).toEqual(['e8']);

    // The demo moment: E8 to Lionel in his first state, then E2.
    expect(await show(host!, 'lionel', 'e8')).toContain("That's my scarf. Fine: I didn't go straight to the car.");
    expect(await show(host!, 'lionel', 'e2')).toContain('Fine. I went in by the hatch.');
    expect(await show(host!, 'lionel', 'e2')).toContain("I've told you what happened.");
    expect(await talk(host!, 'lionel', 'You killed her. Confess.')).toContain('usually in March');
    expect(await talk(guest!, 'aroha', 'What did you see?')).toContain('one bottle smash');

    // The game master tick: the key cards are found, so it tells the host (only) to move on.
    expect((await srv.dispatcher.tick()).enqueued).toBe(1);
    await srv.worker.wake();
    const hostNotices = (await host!.state()).body.notices;
    expect(hostNotices).toEqual([expect.objectContaining({ kind: 'suggest_advance' })]);
    expect((await guest!.state()).body.notices).toEqual([]);

    // 7. The host advances. 8. The group accuses Lionel with E8, E7 and E2.
    expect((await guest!.accuse('lionel', ['e8'])).status).toBe(409); // not open yet
    expect((await host!.advance()).status).toBe(200);
    expect((await host!.accuse('lionel', ['e8', 'e7', 'e2'])).status).toBe(403); // E7 is the guest's
    expect((await guest!.share('e7')).status).toBe(200);
    const acc = await host!.accuse('lionel', ['e8', 'e7', 'e2'], 'Scarf, shoes and the hatch.');
    expect(acc.status).toBe(200);
    expect((await guest!.accuse('dougal', [])).status).toBe(409); // one per game
    expect((await guest!.inspect('kitchen', 'chiller')).status).toBe(409); // investigation closed
    const submitted = (await guest!.state()).body.accusation.submitted;
    expect(submitted).toMatchObject({
      by: 'Hana',
      suspectName: 'Lionel Fitch',
      reasoning: 'Scarf, shoes and the hatch.',
    });

    // Nothing that names the killer or the verdict has reached either browser so far.
    await sleep(100);
    expectNoSolution([...host!.log, ...guest!.log, JSON.stringify(hostSse.events), JSON.stringify(guestSse.events)]);
    expect(host!.log.length + guest!.log.length).toBeGreaterThan(30);

    // The guest cannot end the game; the host can.
    expect((await guest!.end()).status).toBe(403);
    expect((await host!.end()).status).toBe(200);
    const reveal = (await guest!.state()).body.reveal;
    expect(reveal.killer).toEqual({ id: 'lionel', name: 'Lionel Fitch' });
    expect(reveal.verdict).toMatchObject({ outcome: 'solved-cleanly', verdict: 'solved', title: 'Solved cleanly' });
    expect(reveal.accusation.evidence.map((e: { id: string }) => e.id)).toEqual(['e8', 'e7', 'e2']);
    expect(reveal.narration).toBe(c.solution.narration);
    expect(reveal.clues.length).toBe(c.solution.clues.length);
    expect(reveal.redHerrings.map((r: { id: string }) => r.id)).toEqual(c.red_herrings.map((r) => r.id));

    // Commentary arrives afterwards, labelled as simulated.
    expect((await guest!.state()).body.commentary).toBeNull();
    await srv.worker.wake();
    const commentary = (await guest!.state()).body.commentary;
    expect(commentary.simulated).toBe(true);
    expect(commentary.text).toContain('The group accused Lionel Fitch');
    await guestSse.waitFor((ev) => ev.some((e) => e.type === 'commentary'));
    await Promise.all([hostSse.close(), guestSse.close()]);
  });

  it('accusing Dougal with Act II evidence alone reveals as unsolved, and shows the herrings followed', async () => {
    srv = await startServer({ caseFile: REAL_CASE });
    const [host, guest] = await startedGame(srv.baseUrl, ['Hana', 'Rawiri']);
    await host!.advance();
    await found(guest!, 'office', 'phone');
    await found(guest!, 'office', 'desk');
    expect(await show(guest!, 'dougal', 'e6')).toContain("That's not me. I've known Helen twelve years");
    expect(await show(guest!, 'dougal', 'e5')).toContain('That was me. I rang the buyer');
    expect(await show(guest!, 'dougal', 'e5')).toContain("I've owned up to that.");
    await host!.advance();
    expect((await guest!.accuse('dougal', ['e5', 'e6'], 'Money and Monday.')).status).toBe(200);
    expect((await host!.end()).status).toBe(200);
    const reveal = (await host!.state()).body.reveal;
    expect(reveal.verdict).toMatchObject({ outcome: 'unsolved', verdict: 'unsolved' });
    expect(
      reveal.redHerrings.filter((r: { followed: boolean }) => r.followed).map((r: { id: string }) => r.id),
    ).toEqual(['dougal-theory']);
  });
});

describe('acts and the game master', () => {
  async function backdate(sql: string) {
    await srv.db.query(sql);
  }

  it('advances Act I on a timer through the dispatcher, but never ends the game', async () => {
    srv = await startServer({ caseFile: REAL_CASE, gmTickSeconds: 0 });
    const [host] = await startedGame(srv.baseUrl);
    await srv.dispatcher.tick();
    expect((await host!.state()).body.act.number).toBe(1);
    await backdate(`UPDATE games SET act_started_at = jsonb_build_object('1', now() - interval '13 minutes')`);
    await srv.dispatcher.tick();
    expect((await host!.state()).body.act.number).toBe(2);
    await backdate(
      `UPDATE games SET act_started_at = act_started_at || jsonb_build_object('2', now() - interval '19 minutes')`,
    );
    await srv.dispatcher.tick();
    await srv.dispatcher.tick();
    const view = (await host!.state()).body;
    expect(view.act.number).toBe(3);
    expect(view.status).toBe('active');
  });

  it('gives a stalled game an allowed hint without anyone asking, and skips idle games', async () => {
    srv = await startServer({ caseFile: REAL_CASE, gmTickSeconds: 0.001 });
    const [host, guest] = await startedGame(srv.baseUrl);
    await host!.advance();
    // Act II has run five minutes with nothing found.
    await backdate(
      `UPDATE games SET act_started_at = act_started_at || jsonb_build_object('2', now() - interval '5 minutes'),
                        last_progress_at = now() - interval '5 minutes'`,
    );
    const guestSse = openSse(guest!);
    await guestSse.ready;
    expect((await srv.dispatcher.tick()).enqueued).toBe(1);
    expect((await srv.dispatcher.tick()).enqueued).toBe(0); // one tick open at a time
    await srv.worker.wake();
    const notice = await guestSse.waitFor((ev) => ev.some((e) => e.type === 'gm_notice'));
    expect(notice.find((e) => e.type === 'gm_notice')!.payload).toEqual({
      id: 'hint:h1',
      kind: 'hint',
      text: c.hints[0]!.text,
    });
    await guestSse.close();
    expect((await guest!.state()).body.notices.map((n: { id: string }) => n.id)).toEqual(['hint:h1']);

    // An idle game gets no ticks.
    await backdate(`UPDATE games SET last_activity_at = now() - interval '1 hour'`);
    expect((await srv.dispatcher.tick()).enqueued).toBe(0);
  });

  it('applies only allowed game-master choices', async () => {
    srv = await startServer({ caseFile: REAL_CASE, gmTickSeconds: 0.001 });
    const [host] = await startedGame(srv.baseUrl);
    const agent = new AppClient(srv.baseUrl, SECRET);
    for (const choice of ['hint:h3', 'reveal_the_killer', 'suggest_advance', 'event:lights']) {
      await srv.db.query(`UPDATE games SET last_gm_tick_at = now() - interval '1 minute'`);
      expect((await srv.dispatcher.tick()).enqueued).toBe(1);
      const job = (await agent.claim())!;
      expect(job.kind).toBe('gm_tick');
      if (job.kind !== 'gm_tick') return;
      expect(JSON.stringify(job.context)).not.toContain('lionel');
      await agent.complete(job.id, {
        leaseToken: job.leaseToken,
        output: { choice_id: choice, reason: 'test' },
        simulated: true,
        usage: null,
      });
    }
    const { rows } = await srv.db.query('SELECT intervention_id FROM game_interventions');
    expect(rows.map((r) => r.intervention_id)).toEqual(['event:lights']);
    const { rows: results } = await srv.db.query("SELECT result FROM jobs WHERE kind = 'gm_tick' ORDER BY id");
    expect(results.map((r) => [r.result.choiceId, r.result.applied])).toEqual([
      ['hint:h3', false],
      ['reveal_the_killer', false],
      ['suggest_advance', false],
      ['event:lights', true],
    ]);
    expect((await host!.state()).body.notices).toEqual([expect.objectContaining({ kind: 'event' })]);
  });

  it('lets only the host give the next hint by hand, in order', async () => {
    srv = await startServer({ caseFile: REAL_CASE, gmTickSeconds: 0 });
    const [host, guest] = await startedGame(srv.baseUrl);
    expect((await guest!.hint()).status).toBe(403);
    expect((await host!.hint()).body).toEqual({ text: c.hints[0]!.text });
    expect((await host!.hint()).body).toEqual({ text: c.hints[1]!.text });
    const third = await host!.hint();
    expect(third.body.text).toMatch(/^Inspect the storm hatch/); // the Woodshed is still locked
    expect((await host!.hint()).status).toBe(409);
    expect((await guest!.state()).body.notices.map((n: { id: string }) => n.id)).toEqual([
      'hint:h1',
      'hint:h2',
      'hint:h3',
    ]);
  });
});
