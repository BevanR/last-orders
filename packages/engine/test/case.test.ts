import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accuse,
  advanceAct,
  allowedInterventions,
  applyPresent,
  autoAdvance,
  availableActions,
  buildSuspectContext,
  discover,
  heldEvidenceIds,
  matchingTransition,
  newGameState,
  nextHint,
  parseCase,
  present,
  redact,
  scoreAccusation,
  unlockedActions,
  type CaseFile,
  type GameState,
} from '../src/index.js';

/** The authored case, from case/last-orders.case.json. */
const c: CaseFile = parseCase(
  JSON.parse(readFileSync(new URL('../../../case/last-orders.case.json', import.meta.url), 'utf8')),
);

const HOST = { id: 'p-host', name: 'Hana', isHost: true };
const GUEST = { id: 'p-guest', name: 'Rawiri', isHost: false };
const MIN = 60_000;

/** A game driven only through the engine's rules, the way the server applies them. */
class Sim {
  s: GameState;
  constructor() {
    this.s = { ...newGameState(c, 0, [HOST, GUEST]), status: 'active', actStartedAt: { 1: 0 } };
  }
  wait(minutes: number) {
    this.s.now += minutes * MIN;
    this.auto();
  }
  private auto() {
    for (let next = autoAdvance(c, this.s); next !== null; next = autoAdvance(c, this.s)) this.setAct(next);
  }
  setAct(n: number) {
    this.s.act = n;
    this.s.actStartedAt[n] = this.s.now;
  }
  advance() {
    this.setAct(advanceAct(c, this.s).act);
  }
  interview(suspectId: string) {
    if (!this.s.interviewed.includes(suspectId)) this.s.interviewed.push(suspectId);
    this.auto();
  }
  inspect(playerId: string, locationId: string, actionId: string): string[] {
    const r = discover(c, this.s, playerId, locationId, actionId);
    this.s.visits.push({ locationId, actionId, playerId });
    for (const e of r.found) this.s.discoveries.push({ evidenceId: e.id, playerId });
    if (r.found.length) this.s.lastProgressAt = this.s.now;
    this.auto();
    return r.found.map((e) => e.id);
  }
  share(playerId: string, evidenceId: string) {
    if (!this.s.board.some((b) => b.evidenceId === evidenceId)) this.s.board.push({ evidenceId, sharedBy: playerId });
    this.auto();
  }
  present(playerId: string, suspectId: string, evidenceId: string) {
    const r = present(c, this.s, playerId, suspectId, evidenceId);
    applyPresent(this.s, r, playerId);
    this.auto();
    return r;
  }
  locationOpen(id: string) {
    return redact(c, this.s, { kind: 'player', playerId: HOST.id }).locations.some((l) => l.id === id);
  }
}

describe('the authored case', () => {
  it('has the shape the bible describes', () => {
    expect(c.acts.map((a) => a.name)).toEqual(['First Accounts', 'Contradictions', 'Accusation']);
    expect(c.suspects.map((s) => s.name)).toEqual(['Lionel Fitch', 'Dougal Price', 'Tessa Marsh', 'Aroha Mitchell']);
    expect(c.evidence.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8']);
    expect(c.transitions.map((t) => t.id)).toEqual([
      'tl1',
      'tl2',
      'tl3',
      'tl4',
      'tl5',
      'td1',
      'td2',
      'tt1',
      'tt2',
      'ta1',
      'ta2',
    ]);
    expect(c.solution.killer_suspect_id).toBe('lionel');
    // Every suspect has a default line and a "don't know" line, and every innocent an "already told" line.
    for (const s of c.suspects) {
      expect(s.default_line).toBeTruthy();
      expect(s.dont_know_line).toBeTruthy();
      if (s.id !== 'lionel') expect(s.already_told_line).toBeTruthy();
    }
  });
});

describe('scripted playthrough (bible §14)', () => {
  it('the minimal solving sequence reaches a clean "solved" verdict', () => {
    const g = new Sim();
    // 1. First accounts from three suspects.
    for (const id of ['lionel', 'dougal', 'tessa']) g.interview(id);
    expect(g.s.act).toBe(1);
    // 2. The camera.
    expect(g.inspect(HOST.id, 'dining-room', 'camera')).toEqual(['e3']);
    expect(g.s.act).toBe(1);
    // 3. The foot of the stairs: Act II starts on its own.
    expect(g.inspect(GUEST.id, 'wine-cellar', 'foot-of-stairs')).toEqual(['e1']);
    expect(g.s.act).toBe(2);
    // 4. The storm hatch: the Woodshed unlocks.
    expect(g.locationOpen('woodshed')).toBe(false);
    expect(g.inspect(HOST.id, 'wine-cellar', 'storm-hatch')).toEqual(['e2']);
    expect(g.locationOpen('woodshed')).toBe(true);
    // 5. The boot room.
    expect(g.inspect(GUEST.id, 'boot-room', 'shoe-rack')).toEqual(['e7']);
    // 6. The woodpile: the game master may suggest Act III.
    expect(allowedInterventions(c, g.s).map((i) => i.id)).not.toContain('suggest_advance');
    expect(g.inspect(HOST.id, 'woodshed', 'woodpile')).toEqual(['e8']);
    expect(allowedInterventions(c, g.s).map((i) => i.id)).toContain('suggest_advance');
    // 7. The host advances.
    expect(availableActions(c, g.s, HOST.id).accuse).toBe(false);
    g.advance();
    expect(g.s.act).toBe(3);
    // 8. Accuse Lionel citing E8, E7 and E2 (the guest's E7 reaches the host through the board).
    g.share(GUEST.id, 'e7');
    expect(availableActions(c, g.s, HOST.id).accuse).toBe(true);
    const a = accuse(c, g.s, HOST.id, 'lionel', ['e8', 'e7', 'e2']);
    expect(a.outcome).toMatchObject({ id: 'solved-cleanly', verdict: 'solved' });
  });

  it('the demo sequence: E8 to Lionel in his first state, then E2', () => {
    const g = new Sim();
    g.advance();
    g.inspect(HOST.id, 'wine-cellar', 'storm-hatch');
    g.inspect(HOST.id, 'woodshed', 'woodpile');
    expect(g.s.suspectStates.lionel).toEqual({ where: 'lionel-car-story', money: 'lionel-money-hidden' });

    const scarf = g.present(HOST.id, 'lionel', 'e8');
    expect(scarf.transition?.id).toBe('tl2');
    expect(scarf.transition?.account).toMatch(/^That's my scarf\. Fine: I didn't go straight to the car\./);

    const hatch = g.present(HOST.id, 'lionel', 'e2');
    expect(hatch.transition?.id).toBe('tl3');
    expect(hatch.transition?.account).toMatch(/^Fine\. I went in by the hatch\./);
    expect(hatch.transition?.account).toContain('she slipped');
    expect(g.s.suspectStates.lionel).toEqual({ where: 'lionel-in-cellar', money: 'lionel-money-admitted' });

    // After the change, the cards he has seen give his "already told" reactions.
    expect(g.present(HOST.id, 'lionel', 'e2').reaction.line).toBe("I've told you what happened.");
    expect(g.present(HOST.id, 'lionel', 'e8').reaction.line).toBe("I've told you what happened.");
    g.inspect(HOST.id, 'wine-cellar', 'foot-of-stairs');
    expect(g.present(HOST.id, 'lionel', 'e1').reaction.line).toBe("I've told you. I know nothing about that bottle.");
    expect(g.s.firedTransitions).toEqual(['tl2', 'tl3']);
  });

  it('the other order also reaches his last account: E7, then E8', () => {
    const g = new Sim();
    g.advance();
    g.inspect(HOST.id, 'boot-room', 'shoe-rack');
    g.inspect(HOST.id, 'wine-cellar', 'storm-hatch');
    g.inspect(HOST.id, 'woodshed', 'woodpile');
    expect(g.present(HOST.id, 'lionel', 'e7').transition?.id).toBe('tl1');
    expect(g.present(HOST.id, 'lionel', 'e8').transition?.id).toBe('tl4');
    expect(g.present(HOST.id, 'lionel', 'e2').transition).toBeNull();
  });

  it('scores accusations deterministically; Dougal on Act II evidence alone is wrong', () => {
    const score = (suspectId: string, evidenceIds: string[]) => scoreAccusation(c, { suspectId, evidenceIds });
    expect(score('dougal', ['e5', 'e6', 'e2'])).toMatchObject({ id: 'unsolved', verdict: 'unsolved' });
    expect(score('dougal', ['e7', 'e8'])).toMatchObject({ verdict: 'unsolved' });
    expect(score('aroha', ['e1'])).toMatchObject({ verdict: 'unsolved' });
    expect(score('lionel', ['e2', 'e6', 'e3'])).toMatchObject({ id: 'thin', verdict: 'thin' });
    expect(score('lionel', [])).toMatchObject({ id: 'thin' });
    expect(score('lionel', ['e7'])).toMatchObject({ id: 'solved', verdict: 'solved' });
    expect(score('lionel', ['e8', 'e2'])).toMatchObject({ id: 'solved', verdict: 'solved' });
    expect(score('lionel', ['e8', 'e7', 'e2'])).toMatchObject({ id: 'solved-cleanly', verdict: 'solved' });

    // Through the rules, too: the group accuses Dougal with the office and hatch cards.
    const g = new Sim();
    g.advance();
    for (const [l, a] of [
      ['office', 'phone'],
      ['office', 'desk'],
      ['wine-cellar', 'storm-hatch'],
    ] as const)
      g.inspect(HOST.id, l, a);
    g.advance();
    expect(accuse(c, g.s, HOST.id, 'dougal', ['e5', 'e6', 'e2']).outcome.verdict).toBe('unsolved');
  });
});

describe('reachability', () => {
  it('every evidence card is reachable through visible actions alone', () => {
    const g = new Sim();
    for (let round = 0; round < 10; round++) {
      let progressed = false;
      for (const loc of c.locations) {
        for (const action of unlockedActions(loc, g.s)) {
          if (g.inspect(HOST.id, loc.id, action.id).length) progressed = true;
        }
      }
      if (!progressed && g.s.act < c.acts.length) g.advance();
      else if (!progressed) break;
    }
    expect(new Set(g.s.discoveries.map((d) => d.evidenceId))).toEqual(new Set(c.evidence.map((e) => e.id)));
  });

  it('each card comes from exactly the action the bible names', () => {
    const where = Object.fromEntries(
      c.evidence.map((e) => [e.id, `${e.discovery.location_id}/${e.discovery.action_id}`]),
    );
    expect(where).toEqual({
      e1: 'wine-cellar/foot-of-stairs',
      e2: 'wine-cellar/storm-hatch',
      e3: 'dining-room/camera',
      e4: 'kitchen/chiller',
      e5: 'office/phone',
      e6: 'office/desk',
      e7: 'boot-room/shoe-rack',
      e8: 'woodshed/woodpile',
    });
  });

  it('Act I offers only E1, E3 and E4, and only TT1 and TA2 can fire', () => {
    const g = new Sim();
    const found = c.locations.flatMap((l) => unlockedActions(l, g.s).flatMap((a) => g.inspect(HOST.id, l.id, a.id)));
    expect(found.sort()).toEqual(['e1', 'e3', 'e4']);
    const fireable = new Set<string>();
    for (const s of c.suspects)
      for (const e of heldEvidenceIds(g.s, HOST.id)) {
        const t = matchingTransition(c, g.s, s.id, e);
        if (t) fireable.add(t.id);
      }
    expect([...fireable].sort()).toEqual(['ta2', 'tt1']);
  });

  it('the Woodshed also opens through Tessa (TT1) without the storm hatch', () => {
    const g = new Sim();
    g.inspect(HOST.id, 'dining-room', 'camera');
    expect(g.present(HOST.id, 'tessa', 'e3').transition?.id).toBe('tt1');
    expect(g.locationOpen('woodshed')).toBe(false); // still Act I
    g.advance();
    expect(g.locationOpen('woodshed')).toBe(true);
    expect(g.inspect(HOST.id, 'woodshed', 'woodpile')).toEqual(['e8']);
  });

  it('every testimony transition is reachable and fires at most once on every path', () => {
    // Explore every order of presentations from Act II with all cards in hand.
    const start = new Sim();
    start.advance();
    for (const loc of c.locations) for (const a of unlockedActions(loc, start.s)) start.inspect(HOST.id, loc.id, a.id);
    for (const loc of c.locations) for (const a of unlockedActions(loc, start.s)) start.inspect(HOST.id, loc.id, a.id);
    expect(heldEvidenceIds(start.s, HOST.id).sort()).toEqual(c.evidence.map((e) => e.id));

    const seen = new Set<string>();
    const reached = new Set<string>();
    const queue: GameState[] = [start.s];
    let states = 0;
    while (queue.length) {
      const s = queue.shift()!;
      const key = JSON.stringify([...s.firedTransitions].sort());
      if (seen.has(key)) continue;
      seen.add(key);
      states++;
      // Alternative routes exclude each other.
      expect(s.firedTransitions.includes('tl1') && s.firedTransitions.includes('tl2')).toBe(false);
      expect(s.firedTransitions.includes('tl3') && s.firedTransitions.includes('tl4')).toBe(false);
      for (const suspect of c.suspects) {
        for (const e of c.evidence) {
          const next = structuredClone(s);
          const r = present(c, next, HOST.id, suspect.id, e.id);
          if (!r.transition) continue;
          expect(s.firedTransitions).not.toContain(r.transition.id);
          applyPresent(next, r, HOST.id);
          reached.add(r.transition.id);
          // Presenting the same card again never fires the same transition.
          expect(present(c, next, HOST.id, suspect.id, e.id).transition?.id).not.toBe(r.transition.id);
          queue.push(next);
        }
      }
    }
    expect([...reached].sort()).toEqual(c.transitions.map((t) => t.id).sort());
    expect(states).toBeGreaterThan(11);
  });
});

describe('acts', () => {
  it('Act I advances after 12 minutes, Act II after 18, and the game never ends on a timer', () => {
    const g = new Sim();
    g.wait(11);
    expect(g.s.act).toBe(1);
    g.wait(1);
    expect(g.s.act).toBe(2);
    g.wait(17);
    expect(g.s.act).toBe(2);
    g.wait(1);
    expect(g.s.act).toBe(3);
    g.wait(600);
    expect(g.s.act).toBe(3);
    expect(g.s.status).toBe('active');
  });

  it('Act I does not advance on evidence without three accounts', () => {
    const g = new Sim();
    g.inspect(HOST.id, 'dining-room', 'camera');
    g.inspect(HOST.id, 'wine-cellar', 'foot-of-stairs');
    g.interview('aroha');
    g.interview('aroha');
    g.interview('tessa');
    expect(g.s.act).toBe(1);
    g.interview('dougal');
    expect(g.s.act).toBe(2);
  });
});

describe('game master', () => {
  const ids = (g: Sim) => allowedInterventions(c, g.s).map((i) => i.id);

  it('delivers the hints in order, on the bible timings', () => {
    const g = new Sim();
    g.advance();
    expect(ids(g)).not.toContain('hint:h1');
    g.wait(4);
    expect(ids(g)).toContain('hint:h1');
    const h1 = allowedInterventions(c, g.s).find((i) => i.id === 'hint:h1')!;
    g.s.interventions.push({ id: h1.recordId, text: h1.text, at: g.s.now });
    expect(ids(g)).not.toContain('hint:h2');
    g.wait(4);
    expect(ids(g)).toContain('hint:h2');
    g.s.interventions.push({ id: 'hint:h2', text: '', at: g.s.now });
    g.wait(4);
    const h3 = allowedInterventions(c, g.s).find((i) => i.id === 'hint:h3')!;
    expect(h3.text).toMatch(/^Inspect the storm hatch/); // the Woodshed is still locked
    g.inspect(HOST.id, 'wine-cellar', 'storm-hatch');
    expect(allowedInterventions(c, g.s).find((i) => i.id === 'hint:h3')!.text).toMatch(/^Something was hidden/);
    g.inspect(HOST.id, 'woodshed', 'woodpile');
    g.share(HOST.id, 'e8');
    expect(ids(g)).not.toContain('hint:h3'); // E8 is found and on the board
  });

  it('skips H1 when two of E2, E7 and E8 are already found, and H3 waits for H2', () => {
    const g = new Sim();
    g.advance();
    g.inspect(HOST.id, 'wine-cellar', 'storm-hatch');
    g.inspect(HOST.id, 'boot-room', 'shoe-rack');
    g.wait(5);
    expect(ids(g).some((x) => x.startsWith('hint:'))).toBe(false);
    g.advance();
    expect(ids(g).some((x) => x.startsWith('hint:'))).toBe(false); // H3 cannot come before H1 and H2
    expect(nextHint(c, g.s)?.id).toBe('h1'); // the host can still give the next one by hand
  });

  it('highlights the Boot Room, and nudges after Lionel first changes his story', () => {
    const g = new Sim();
    g.advance();
    g.wait(5);
    expect(ids(g)).toContain('highlight_location:boot-room');
    g.inspect(GUEST.id, 'boot-room', 'shoe-rack');
    expect(ids(g)).not.toContain('highlight_location:boot-room');
    g.present(GUEST.id, 'lionel', 'e7');
    expect(ids(g)).not.toContain('notice:lionel-changed');
    g.wait(3);
    expect(ids(g)).toContain('notice:lionel-changed');
    g.inspect(GUEST.id, 'wine-cellar', 'storm-hatch');
    g.present(GUEST.id, 'lionel', 'e2');
    expect(ids(g)).not.toContain('notice:lionel-changed');
  });
});

describe('secrecy', () => {
  const solutionStrings = [
    c.solution.summary,
    c.solution.motive,
    c.solution.method,
    c.solution.narration,
    ...c.solution.clues.map((k) => k.text),
    ...c.accusation.outcomes.map((o) => o.text),
    ...c.red_herrings.map((r) => r.text),
  ];

  it('no view carries the solution, testimony states or transitions before the end', () => {
    const g = new Sim();
    const check = () => {
      for (const audience of [
        { kind: 'public' as const },
        { kind: 'player' as const, playerId: GUEST.id },
        { kind: 'host' as const, playerId: HOST.id },
      ]) {
        const json = JSON.stringify(redact(c, g.s, audience));
        for (const secret of solutionStrings) expect(json).not.toContain(secret);
        for (const t of c.transitions) expect(json).not.toContain(t.account);
        for (const s of c.suspects) {
          expect(json).not.toContain(s.persona);
          for (const th of s.threads) for (const st of th.states) expect(json).not.toContain(`"${st.id}"`);
        }
        expect(json).not.toContain('killer');
        expect(json).not.toContain('reveal');
      }
    };
    check();
    for (const id of ['lionel', 'dougal', 'tessa']) g.interview(id);
    g.inspect(HOST.id, 'dining-room', 'camera');
    g.inspect(HOST.id, 'wine-cellar', 'foot-of-stairs');
    g.inspect(HOST.id, 'wine-cellar', 'storm-hatch');
    g.inspect(HOST.id, 'woodshed', 'woodpile');
    g.present(HOST.id, 'lionel', 'e8');
    g.present(HOST.id, 'lionel', 'e2');
    check();
    g.advance();
    g.s.accusation = { playerId: HOST.id, suspectId: 'lionel', evidenceIds: ['e8', 'e2'], reasoning: '', at: g.s.now };
    check();
    g.s.status = 'ended';
    const reveal = redact(c, g.s, { kind: 'player', playerId: GUEST.id }).reveal!;
    expect(reveal.killer.name).toBe('Lionel Fitch');
    expect(reveal.verdict).toMatchObject({ outcome: 'solved', verdict: 'solved' });
    expect(reveal.narration).toBe(c.solution.narration);
  });

  it('derives which red herrings the group followed', () => {
    const g = new Sim();
    g.inspect(HOST.id, 'dining-room', 'camera');
    g.present(HOST.id, 'tessa', 'e3');
    g.advance();
    g.inspect(HOST.id, 'office', 'desk');
    g.present(HOST.id, 'dougal', 'e6');
    g.advance();
    g.s.accusation = { playerId: HOST.id, suspectId: 'dougal', evidenceIds: ['e6'], reasoning: 'Money.', at: 0 };
    g.s.status = 'ended';
    const reveal = redact(c, g.s, { kind: 'public' }).reveal!;
    expect(reveal.redHerrings.filter((r) => r.followed).map((r) => r.id)).toEqual(['dougal-theory', 'tessa-absence']);
    expect(reveal.verdict.verdict).toBe('unsolved');
    expect(reveal.accusation).toMatchObject({ by: 'Hana', suspect: { name: 'Dougal Price' }, reasoning: 'Money.' });
  });

  it("a suspect's context holds only that suspect's slice; the killer's never says what he did", () => {
    const g = new Sim();
    const ctxs = Object.fromEntries(
      c.suspects.map((s) => [s.id, JSON.stringify(buildSuspectContext(c, g.s, s.id, { history: [] }))]),
    );
    for (const s of c.suspects) {
      for (const secret of solutionStrings) expect(ctxs[s.id]).not.toContain(secret);
      for (const other of c.suspects.filter((x) => x.id !== s.id)) {
        if (other.unrelated_secret) expect(ctxs[s.id]).not.toContain(other.unrelated_secret.text);
        for (const f of other.not_volunteered) expect(ctxs[s.id]).not.toContain(f);
      }
    }
    // Lionel's first-state brief has his lies, not the truth of the hatch.
    expect(ctxs.lionel).toContain('Must have left it in the car.');
    expect(ctxs.lionel).not.toContain('storm-hatch bolt');
    const brief = buildSuspectContext(c, g.s, 'lionel', { history: [] });
    expect(
      JSON.stringify([brief.knows, brief.keep_quiet, brief.authorised_lies, brief.account, brief.suspect]),
    ).not.toMatch(/struck|strike|killed|weapon/i);
    // Aroha does not hear Lionel's pill line (she was in the kitchen).
    expect(ctxs.aroha).not.toContain('blood-pressure pills');
    expect(ctxs.dougal).toContain('blood-pressure pills');
  });
});
