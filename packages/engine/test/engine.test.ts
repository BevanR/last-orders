import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  advanceAct,
  allowedInterventions,
  autoAdvance,
  availableActions,
  buildGmContext,
  buildSuspectContext,
  discover,
  isAllowedIntervention,
  newGameState,
  parseCase,
  present,
  redact,
  RuleError,
  share,
  start,
  type CaseFile,
  type GameState,
} from '../src/index.js';

const raw = JSON.parse(
  readFileSync(new URL('./fixtures/fixture.case.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const c: CaseFile = parseCase(raw);

const A = { id: 'p-a', name: 'Alice', isHost: true };
const B = { id: 'p-b', name: 'Bob', isHost: false };

function active(overrides: Partial<GameState> = {}): GameState {
  return { ...newGameState(c, 0, [A, B]), status: 'active', ...overrides };
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
  });

  it('rejects broken references with readable paths', () => {
    const bad = structuredClone(raw) as any;
    bad.transitions[0].to_state = 'nope';
    bad.evidence[0].discovery.location_id = 'attic';
    bad.solution.killer_suspect_id = 'ghost';
    bad.locations[2].unlock = { evidence_discovered: 'missing' };
    expect(() => parseCase(bad)).toThrow(/to_state "nope"[\s\S]*/);
    try {
      parseCase(bad);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('unknown location "attic"');
      expect(msg).toContain('unknown killer "ghost"');
      expect(msg).toContain('unknown evidence "missing"');
    }
  });

  it('rejects unknown keys and duplicate ids', () => {
    const bad = structuredClone(raw) as any;
    bad.suspects[1].id = 'ada';
    expect(() => parseCase(bad)).toThrow(/duplicate id "ada"/);
    const extra = structuredClone(raw) as any;
    extra.suspects[0].is_killer = true;
    expect(() => parseCase(extra)).toThrow();
  });
});

describe('rules', () => {
  it('requires an active game', () => {
    const s = newGameState(c, 0, [A]);
    expect(code(() => discover(c, s, A.id, 'bar'))).toBe('game_not_active');
    expect(start(s)).toEqual({ act: 1 });
    expect(code(() => start(active()))).toBe('game_not_in_lobby');
  });

  it('discovers evidence per player and respects location unlocks', () => {
    const s = active();
    expect(discover(c, s, A.id, 'bar').found.map((e) => e.id)).toEqual(['torn-receipt']);
    expect(code(() => discover(c, s, A.id, 'cellar'))).toBe('location_locked');
    expect(code(() => discover(c, s, A.id, 'attic'))).toBe('unknown_location');
    s.discoveries.push({ evidenceId: 'torn-receipt', playerId: A.id });
    expect(discover(c, s, A.id, 'bar').found).toEqual([]);
    expect(discover(c, s, B.id, 'bar').found.map((e) => e.id)).toEqual(['torn-receipt']);
    s.discoveries.push({ evidenceId: 'cellar-key', playerId: B.id });
    expect(discover(c, s, A.id, 'cellar').found.map((e) => e.id)).toEqual(['wine-stain']);
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
    expect(present(c, s, A.id, 'ada', 'torn-receipt').transition?.id).toBe('ada-admits-stockroom');
    expect(present(c, s, A.id, 'bram', 'torn-receipt').transition).toBeNull();

    s.board.push({ evidenceId: 'torn-receipt', sharedBy: A.id });
    expect(present(c, s, B.id, 'ada', 'torn-receipt').transition?.id).toBe('ada-admits-stockroom');

    const fired = { ...s, firedTransitions: ['ada-admits-stockroom'] };
    expect(present(c, fired, A.id, 'ada', 'torn-receipt').transition).toBeNull();
    const moved = { ...s, suspectStates: { ...s.suspectStates, ada: 'shaken' } };
    expect(present(c, moved, A.id, 'ada', 'torn-receipt').transition).toBeNull();

    const late = structuredClone(raw) as any;
    late.transitions[0].min_act = 2;
    const c2 = parseCase(late);
    expect(present(c2, s, A.id, 'ada', 'torn-receipt').transition).toBeNull();
    expect(present(c2, { ...s, act: 2 }, A.id, 'ada', 'torn-receipt').transition?.id).toBe(
      'ada-admits-stockroom',
    );
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
    expect(availableActions(c, s, B.id).share).toEqual([]);
    expect(availableActions(c, newGameState(c, 0), A.id).inspect).toEqual([]);
  });
});

describe('redaction', () => {
  const hidden = (x: CaseFile) => [
    x.solution.motive,
    x.solution.method,
    ...x.suspects.flatMap((s) => [
      s.persona,
      s.voice,
      s.unrelated_secret,
      ...s.states.flatMap((st) => [st.id, st.account, ...st.facts.map((f) => f.text)]),
    ]),
    ...x.transitions.flatMap((t) => [t.id, t.reaction]),
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
      expect(json).not.toContain('solution');
    }
  });

  it('shows a player their own notebook but not other players unshared finds', () => {
    const s = active({ discoveries: [{ evidenceId: 'torn-receipt', playerId: A.id }] });
    expect(redact(c, s, { kind: 'player', playerId: A.id }).notebook.map((e) => e.id)).toEqual([
      'torn-receipt',
    ]);
    expect(redact(c, s, { kind: 'player', playerId: B.id }).notebook).toEqual([]);
    expect(redact(c, s, { kind: 'public' }).notebook).toEqual([]);
    s.board.push({ evidenceId: 'torn-receipt', sharedBy: A.id });
    expect(redact(c, s, { kind: 'player', playerId: B.id }).board).toEqual([
      expect.objectContaining({ id: 'torn-receipt', sharedBy: 'Alice' }),
    ]);
  });

  it('hides locked locations and gives host controls only to the host', () => {
    const s = active();
    expect(redact(c, s, { kind: 'player', playerId: B.id }).locations.map((l) => l.id)).toEqual([
      'bar',
      'kitchen',
    ]);
    expect(redact(c, s, { kind: 'player', playerId: B.id }).host).toBeUndefined();
    expect(redact(c, s, { kind: 'host', playerId: A.id }).host).toEqual({
      canStart: false,
      canAdvance: true,
      nextAct: 'After Hours',
    });
  });

  it('includes the solution once the game has ended', () => {
    expect(redact(c, active({ status: 'ended' }), { kind: 'public' }).solution?.killer_suspect_id).toBe(
      'bram',
    );
  });
});

describe('scoped contexts', () => {
  it('gives a suspect only its own current knowledge slice', () => {
    const s = active();
    const ctx = buildSuspectContext(c, s, 'ada', {
      history: [{ role: 'player', text: 'Where were you?' }],
    });
    expect(ctx.testimony.state).toBe('guarded');
    expect(ctx.testimony.authorised_lies).toEqual(['I never left the bar, not once.']);
    expect(ctx.fired_transition).toBeNull();
    const json = JSON.stringify(ctx);
    expect(json).not.toContain(c.solution.motive);
    expect(json).not.toContain('killer');
    for (const f of c.suspects[1]!.states.flatMap((st) => st.facts)) expect(json).not.toContain(f.text);
    expect(json).not.toContain(c.suspects[1]!.unrelated_secret);
    expect(json).not.toContain('I heard two men arguing'); // ada's later state
  });

  it('describes a fired transition and the evidence presented', () => {
    const s = active({ suspectStates: { ada: 'shaken', bram: 'calm' } });
    const ctx = buildSuspectContext(c, s, 'ada', {
      history: [{ role: 'system', text: 'shows the receipt', presentedEvidenceId: 'torn-receipt' }],
      firedTransitionId: 'ada-admits-stockroom',
    });
    expect(ctx.testimony.state).toBe('shaken');
    expect(ctx.presented_evidence.map((e) => e.id)).toEqual(['torn-receipt']);
    expect(ctx.fired_transition?.new_account).toMatch(/stockroom/);
  });

  it('offers the game master only allowed interventions', () => {
    const s = active({ now: 6 * 60_000 });
    const ids = allowedInterventions(c, s).map((i) => i.id);
    expect(ids).toEqual([
      'none',
      'hint:hint-till',
      'highlight_location:bar',
      'highlight_location:kitchen',
      'suggest_advance',
    ]);
    expect(isAllowedIntervention(c, s, 'hint:hint-till')).toBe(true);
    expect(isAllowedIntervention(c, { ...s, hintsGiven: ['hint-till'] }, 'hint:hint-till')).toBe(false);
    expect(isAllowedIntervention(c, s, 'event:power-flicker')).toBe(false);
    expect(isAllowedIntervention(c, { ...s, act: 2 }, 'event:power-flicker')).toBe(true);
    const gm = buildGmContext(c, s);
    expect(gm.minutesSinceProgress).toBe(6);
    expect(JSON.stringify(gm)).not.toContain(c.solution.motive);
  });
});

describe('scripted playthrough of the fixture', () => {
  it('reaches the second act from discoverable evidence', () => {
    const s = newGameState(c, 0, [A, B]);
    s.status = 'active';
    s.act = start({ ...s, status: 'lobby' }).act;
    for (const e of discover(c, s, A.id, 'bar').found) s.discoveries.push({ evidenceId: e.id, playerId: A.id });
    for (const e of discover(c, s, B.id, 'kitchen').found) s.discoveries.push({ evidenceId: e.id, playerId: B.id });
    for (const e of discover(c, s, B.id, 'cellar').found) s.discoveries.push({ evidenceId: e.id, playerId: B.id });
    share(c, s, B.id, 'wine-stain');
    s.board.push({ evidenceId: 'wine-stain', sharedBy: B.id });
    const p = present(c, s, A.id, 'ada', 'torn-receipt');
    expect(p.transition).not.toBeNull();
    s.suspectStates.ada = p.transition!.to_state;
    s.firedTransitions.push(p.transition!.id);
    expect(autoAdvance(c, s)).toBe(2);
  });
});
