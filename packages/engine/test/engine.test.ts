import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  accuse,
  advanceAct,
  allowedInterventions,
  applyPresent,
  autoAdvance,
  availableActions,
  buildGmContext,
  buildSuspectContext,
  discover,
  isAllowedIntervention,
  newGameState,
  nextHint,
  parseCase,
  present,
  redact,
  RuleError,
  scoreAccusation,
  share,
  start,
  type CaseFile,
  type GameState,
} from '../src/index.js';

const raw = JSON.parse(readFileSync(new URL('./fixtures/fixture.case.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;
const c: CaseFile = parseCase(raw);

const A = { id: 'p-a', name: 'Alice', isHost: true };
const B = { id: 'p-b', name: 'Bob', isHost: false };

function active(overrides: Partial<GameState> = {}): GameState {
  return { ...newGameState(c, 0, [A, B]), status: 'active', actStartedAt: { 1: 0 }, ...overrides };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof RuleError) return e.code;
    throw e;
  }
  return undefined;
}

describe('case schema', () => {
  it('accepts the fixture and applies defaults', () => {
    expect(c.suspects).toHaveLength(2);
    expect(c.evidence).toHaveLength(3);
    expect(c.locations.find((l) => l.id === 'bar')!.unlock).toEqual({ always: true });
    expect(c.transitions[0]!.requires).toEqual({ always: true });
  });

  it('rejects broken references with readable paths', () => {
    const bad = structuredClone(raw) as any;
    bad.transitions[0].to_state = 'nope';
    bad.evidence[0].discovery.location_id = 'attic';
    bad.evidence[1].discovery.action_id = 'nowhere';
    bad.solution.killer_suspect_id = 'ghost';
    bad.locations[2].unlock = { evidence_discovered: 'missing' };
    bad.suspects[0].reactions = [{ evidence_id: 'ghost-card', line: 'x' }];
    let msg = '';
    try {
      parseCase(bad);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('to_state "nope"');
    expect(msg).toContain('unknown location "attic"');
    expect(msg).toContain('unknown action "nowhere"');
    expect(msg).toContain('unknown killer "ghost"');
    expect(msg).toContain('unknown evidence "missing"');
    expect(msg).toContain('unknown evidence "ghost-card"');
  });

  it('rejects unknown keys, duplicate ids and a last outcome that does not match everything', () => {
    const bad = structuredClone(raw) as any;
    bad.suspects[1].id = 'ada';
    expect(() => parseCase(bad)).toThrow(/duplicate id "ada"/);
    const extra = structuredClone(raw) as any;
    extra.suspects[0].is_killer = true;
    expect(() => parseCase(extra)).toThrow();
    const outcomes = structuredClone(raw) as any;
    outcomes.accusation.outcomes.pop();
    expect(() => parseCase(outcomes)).toThrow(/last outcome must match any accusation/);
  });
});

describe('rules', () => {
  it('requires an active game', () => {
    const s = newGameState(c, 0, [A]);
    expect(code(() => discover(c, s, A.id, 'bar', 'till'))).toBe('game_not_active');
    expect(start(s)).toEqual({ act: 1 });
    expect(code(() => start(active()))).toBe('game_not_in_lobby');
  });

  it('discovers evidence per player and action, and respects unlocks', () => {
    const s = active();
    expect(discover(c, s, A.id, 'bar', 'till').found.map((e) => e.id)).toEqual(['torn-receipt']);
    expect(code(() => discover(c, s, A.id, 'cellar', 'steps'))).toBe('location_locked');
    expect(code(() => discover(c, s, A.id, 'attic', 'x'))).toBe('unknown_location');
    expect(code(() => discover(c, s, A.id, 'bar', 'x'))).toBe('unknown_action');
    s.discoveries.push({ evidenceId: 'torn-receipt', playerId: A.id });
    expect(discover(c, s, A.id, 'bar', 'till').found).toEqual([]);
    expect(discover(c, s, B.id, 'bar', 'till').found.map((e) => e.id)).toEqual(['torn-receipt']);
    s.discoveries.push({ evidenceId: 'cellar-key', playerId: B.id });
    expect(discover(c, s, A.id, 'cellar', 'steps').found.map((e) => e.id)).toEqual(['wine-stain']);
  });

  it('shares only evidence the player found', () => {
    const s = active({ discoveries: [{ evidenceId: 'torn-receipt', playerId: A.id }] });
    expect(code(() => share(c, s, B.id, 'torn-receipt'))).toBe('evidence_not_held');
    expect(share(c, s, A.id, 'torn-receipt').alreadyOnBoard).toBe(false);
    s.board.push({ evidenceId: 'torn-receipt', sharedBy: A.id });
    expect(share(c, s, A.id, 'torn-receipt').alreadyOnBoard).toBe(true);
  });

  it('fires a transition only from the right state, evidence, act and once', () => {
    const s = active({ discoveries: [{ evidenceId: 'torn-receipt', playerId: A.id }] });
    expect(code(() => present(c, s, B.id, 'ada', 'torn-receipt'))).toBe('evidence_not_held');
    const r = present(c, s, A.id, 'ada', 'torn-receipt');
    expect(r.transition?.id).toBe('ada-admits-stockroom');
    expect(r.changes).toEqual([{ threadId: 'main', from: 'guarded', to: 'shaken' }]);
    expect(present(c, s, A.id, 'bram', 'torn-receipt')).toMatchObject({
      transition: null,
      reaction: { kind: 'default', line: 'Never seen it.' },
    });

    s.board.push({ evidenceId: 'torn-receipt', sharedBy: A.id });
    expect(present(c, s, B.id, 'ada', 'torn-receipt').transition?.id).toBe('ada-admits-stockroom');

    const fired = structuredClone(s);
    applyPresent(fired, present(c, fired, A.id, 'ada', 'torn-receipt'), A.id);
    expect(fired.suspectStates.ada).toEqual({ main: 'shaken' });
    expect(present(c, fired, A.id, 'ada', 'torn-receipt').transition).toBeNull();

    const late = structuredClone(raw) as any;
    late.transitions[0].min_act = 2;
    const c2 = parseCase(late);
    expect(present(c2, s, A.id, 'ada', 'torn-receipt').transition).toBeNull();
    expect(present(c2, { ...s, act: 2 }, A.id, 'ada', 'torn-receipt').transition?.id).toBe('ada-admits-stockroom');
  });

  it('advances acts manually and automatically', () => {
    const s = active();
    expect(advanceAct(c, s)).toEqual({ act: 2 });
    expect(code(() => advanceAct(c, { ...s, act: 2 }))).toBe('no_next_act');
    expect(autoAdvance(c, s)).toBeNull();
    s.firedTransitions.push('ada-admits-stockroom');
    s.board.push({ evidenceId: 'wine-stain', sharedBy: B.id });
    expect(autoAdvance(c, s)).toBe(2);
    expect(autoAdvance(c, { ...s, act: 2 })).toBeNull();
  });

  it('lists available actions per player', () => {
    const s = active({
      discoveries: [
        { evidenceId: 'torn-receipt', playerId: A.id },
        { evidenceId: 'cellar-key', playerId: B.id },
      ],
      board: [{ evidenceId: 'cellar-key', sharedBy: B.id }],
    });
    const a = availableActions(c, s, A.id);
    expect(a.inspect).toEqual(['bar', 'kitchen', 'cellar']);
    expect(a.share).toEqual(['torn-receipt']);
    expect(a.present.sort()).toEqual(['cellar-key', 'torn-receipt']);
    expect(a.accuse).toBe(false);
    expect(availableActions(c, s, B.id).share).toEqual([]);
    expect(availableActions(c, newGameState(c, 0), A.id).inspect).toEqual([]);
  });

  it('takes one accusation in the final act, scores it, and then closes the investigation', () => {
    const s = active({ discoveries: [{ evidenceId: 'wine-stain', playerId: A.id }] });
    expect(code(() => accuse(c, s, A.id, 'bram', []))).toBe('accusation_not_open');
    s.act = 2;
    expect(code(() => accuse(c, s, B.id, 'bram', ['wine-stain']))).toBe('evidence_not_held');
    expect(code(() => accuse(c, s, A.id, 'bram', ['wine-stain', 'wine-stain']))).toBe('invalid_accusation');
    expect(code(() => accuse(c, s, A.id, 'ghost', []))).toBe('unknown_suspect');
    expect(accuse(c, s, A.id, 'bram', ['wine-stain']).outcome.id).toBe('solved');
    expect(scoreAccusation(c, { suspectId: 'bram', evidenceIds: [] }).id).toBe('thin');
    expect(scoreAccusation(c, { suspectId: 'ada', evidenceIds: ['wine-stain'] }).id).toBe('unsolved');
    s.accusation = { playerId: A.id, suspectId: 'bram', evidenceIds: ['wine-stain'], reasoning: '', at: 0 };
    expect(code(() => accuse(c, s, A.id, 'bram', []))).toBe('accusation_submitted');
    expect(code(() => discover(c, s, A.id, 'bar', 'till'))).toBe('accusation_submitted');
    expect(availableActions(c, s, A.id)).toMatchObject({ inspect: [], present: [], accuse: false });
  });
});

describe('redaction', () => {
  const hidden = (x: CaseFile) => [
    x.solution.summary,
    x.solution.motive,
    x.solution.method,
    x.solution.narration,
    ...x.solution.clues.map((k) => k.text),
    ...x.suspects.flatMap((s) => [
      s.persona,
      s.voice,
      s.first_account,
      s.unrelated_secret?.text ?? s.persona,
      ...s.threads.flatMap((t) => [t.id, ...t.states.flatMap((st) => [st.id, ...st.facts])]),
    ]),
    ...x.transitions.flatMap((t) => [t.id, t.reaction, t.account]),
  ];

  it('never exposes hidden case data before the game ends', () => {
    const s = active({ discoveries: [{ evidenceId: 'torn-receipt', playerId: A.id }] });
    for (const audience of [
      { kind: 'public' as const },
      { kind: 'player' as const, playerId: B.id },
      { kind: 'host' as const, playerId: A.id },
    ]) {
      const json = JSON.stringify(redact(c, s, audience));
      for (const secret of hidden(c)) expect(json).not.toContain(secret);
      expect(json).not.toContain('reveal');
      expect(json).not.toContain('killer');
    }
  });

  it('shows a player their own notebook but not other players unshared finds', () => {
    const s = active({ discoveries: [{ evidenceId: 'torn-receipt', playerId: A.id }] });
    expect(redact(c, s, { kind: 'player', playerId: A.id }).notebook.map((e) => e.id)).toEqual(['torn-receipt']);
    expect(redact(c, s, { kind: 'player', playerId: B.id }).notebook).toEqual([]);
    expect(redact(c, s, { kind: 'public' }).notebook).toEqual([]);
    s.board.push({ evidenceId: 'torn-receipt', sharedBy: A.id });
    expect(redact(c, s, { kind: 'player', playerId: B.id }).board).toEqual([
      expect.objectContaining({ id: 'torn-receipt', sharedBy: 'Alice' }),
    ]);
  });

  it('hides locked locations and gives host controls only to the host', () => {
    const s = active();
    const view = redact(c, s, { kind: 'player', playerId: B.id });
    expect(view.locations.map((l) => l.id)).toEqual(['bar', 'kitchen']);
    expect(view.locations[0]!.actions).toEqual([{ id: 'till', label: 'Check behind the till', done: false }]);
    expect(view.host).toBeUndefined();
    expect(redact(c, s, { kind: 'host', playerId: A.id }).host).toEqual({
      canStart: false,
      canAdvance: true,
      nextAct: 'After Hours',
      canEnd: true,
      canHint: true,
    });
  });

  it('shows notices, keeps suggestions for the host, and hides the verdict until the end', () => {
    const s = active({
      act: 2,
      interventions: [
        { id: 'hint:hint-till', text: 'Someone should look behind the till.', at: 1 },
        { id: 'suggest_advance:1', text: 'Ready.', at: 2 },
      ],
      accusation: { playerId: B.id, suspectId: 'bram', evidenceIds: [], reasoning: 'Flour.', at: 3 },
    });
    expect(redact(c, s, { kind: 'player', playerId: B.id }).notices.map((n) => n.kind)).toEqual(['hint']);
    expect(redact(c, s, { kind: 'host', playerId: A.id }).notices.map((n) => n.kind)).toEqual([
      'hint',
      'suggest_advance',
    ]);
    const view = redact(c, s, { kind: 'player', playerId: A.id });
    expect(view.accusation.submitted).toEqual({
      by: 'Bob',
      suspectId: 'bram',
      suspectName: 'Bram Holt',
      evidence: [],
      reasoning: 'Flour.',
    });
    expect(JSON.stringify(view)).not.toContain('thin');
    const ended = redact(c, { ...s, status: 'ended' }, { kind: 'public' });
    expect(ended.reveal?.killer).toEqual({ id: 'bram', name: 'Bram Holt' });
    expect(ended.reveal?.verdict).toMatchObject({ outcome: 'thin', verdict: 'thin' });
  });
});

describe('scoped contexts', () => {
  it('gives a suspect only its own current knowledge slice', () => {
    const s = active();
    const ctx = buildSuspectContext(c, s, 'ada', { history: [{ role: 'player', text: 'Where were you?' }] });
    expect(ctx.turn).toEqual({ kind: 'account' });
    expect(ctx.authorised_lies).toEqual([
      { text: 'I never left the bar, not once.', when: 'when asked where you were' },
    ]);
    expect(ctx.secret).toEqual({ text: c.suspects[0]!.unrelated_secret!.text, admitted: false });
    expect(ctx.shared_knowledge).toEqual(['The landlord was found in the snug at half eleven.']);
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(c.solution.motive);
    expect(json).not.toContain('killer');
    for (const f of c.suspects[1]!.threads.flatMap((t) => t.states.flatMap((st) => st.facts)))
      expect(json).not.toContain(f);
    expect(json).not.toContain('I heard two men arguing'); // ada's later state
  });

  it('describes a fired transition, a plain reaction, and later questions', () => {
    const s = active({ suspectStates: { ada: { main: 'shaken' }, bram: { main: 'calm' } } });
    s.firedTransitions.push('ada-admits-stockroom');
    const ctx = buildSuspectContext(c, s, 'ada', {
      history: [{ role: 'player', text: 'shows the receipt', presentedEvidenceId: 'torn-receipt' }],
      firedTransitionId: 'ada-admits-stockroom',
    });
    expect(ctx.presented_evidence.map((e) => e.id)).toEqual(['torn-receipt']);
    expect(ctx.turn).toMatchObject({ kind: 'transition', account: expect.stringMatching(/stockroom/) });
    expect(ctx.account.changes).toHaveLength(1);
    expect(ctx.secret?.admitted).toBe(true);

    const again = buildSuspectContext(c, s, 'ada', {
      history: [
        { role: 'player', text: 'hi' },
        { role: 'suspect', text: 'hello' },
        { role: 'player', text: 'shows the receipt', presentedEvidenceId: 'torn-receipt' },
      ],
      reaction: { kind: 'default', line: 'That means nothing to me, love.' },
    });
    expect(again.turn).toMatchObject({ kind: 'evidence', line: 'That means nothing to me, love.' });
    const q = buildSuspectContext(c, s, 'ada', {
      history: [
        { role: 'player', text: 'hi' },
        { role: 'suspect', text: 'hello' },
        { role: 'player', text: 'And then?' },
      ],
    });
    expect(q.turn).toEqual({ kind: 'question', text: 'And then?' });
  });

  it('offers the game master only allowed interventions, hints in order', () => {
    const s = active({ now: 6 * 60_000 });
    const ids = allowedInterventions(c, s).map((i) => i.id);
    expect(ids).toEqual(['none', 'hint:hint-till', 'highlight_location:kitchen']);
    expect(isAllowedIntervention(c, s, 'hint:hint-till')).toBe(true);
    expect(isAllowedIntervention(c, s, 'hint:hint-key')).toBe(false); // not before hint-till
    const given = { ...s, interventions: [{ id: 'hint:hint-till', text: '', at: 0 }] };
    expect(isAllowedIntervention(c, given, 'hint:hint-till')).toBe(false);
    expect(isAllowedIntervention(c, given, 'hint:hint-key')).toBe(true);
    expect(isAllowedIntervention(c, s, 'event:power-flicker')).toBe(false);
    expect(isAllowedIntervention(c, { ...s, act: 2 }, 'event:power-flicker')).toBe(true);
    expect(isAllowedIntervention(c, s, 'suggest_advance')).toBe(false); // act 1 has no suggestion condition
    expect(nextHint(c, given)?.id).toBe('hint-key');
    const gm = buildGmContext(c, s);
    expect(gm.minutesSinceProgress).toBe(6);
    expect(JSON.stringify(gm)).not.toContain(c.solution.motive);
  });
});
