import { z } from 'zod';

/** Lower-case slug used for every authored id. */
export const IdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids are lower-case slugs: a-z, 0-9, "_" and "-"');

/**
 * A condition over game state. Conditions gate locations, actions, evidence, transitions, act
 * advances, hints, game-master interventions, reactions and red herrings. They are evaluated by
 * `evaluateCondition` in state.ts.
 */
export type Condition =
  | { always: true }
  | { act_at_least: number }
  /** True once the act has started and has been running (or ran) for at least `minutes`. */
  | { minutes_since_act_started: { act: number; minutes: number } }
  | { evidence_discovered: string }
  | { evidence_shared: string }
  /** Some player has shown this evidence to this suspect. */
  | { evidence_presented: { suspect: string; evidence: string } }
  | { location_visited: string }
  | { transition_fired: string }
  /** Any of the suspect's testimony threads is in this state. */
  | { suspect_in_state: { suspect: string; state: string } }
  /** At least this many different suspects have been interviewed (and so given their account). */
  | { accounts_given_at_least: number }
  | { minutes_since_progress_at_least: number }
  /** True when nobody has presented evidence to the suspect for this long (or ever). */
  | { minutes_since_presented_to_at_least: { suspect: string; minutes: number } }
  | { hint_given: string }
  | { hint_given_minutes_ago_at_least: { hint: string; minutes: number } }
  | { accusation_submitted: true }
  | { accused: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  /** At least `n` of the conditions hold. */
  | { at_least: { n: number; of: Condition[] } };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ always: z.literal(true) }).strict(),
    z.object({ act_at_least: z.number().int().min(1) }).strict(),
    z
      .object({
        minutes_since_act_started: z.object({ act: z.number().int().min(1), minutes: z.number().min(0) }).strict(),
      })
      .strict(),
    z.object({ evidence_discovered: IdSchema }).strict(),
    z.object({ evidence_shared: IdSchema }).strict(),
    z.object({ evidence_presented: z.object({ suspect: IdSchema, evidence: IdSchema }).strict() }).strict(),
    z.object({ location_visited: IdSchema }).strict(),
    z.object({ transition_fired: IdSchema }).strict(),
    z.object({ suspect_in_state: z.object({ suspect: IdSchema, state: IdSchema }).strict() }).strict(),
    z.object({ accounts_given_at_least: z.number().int().min(0) }).strict(),
    z.object({ minutes_since_progress_at_least: z.number().min(0) }).strict(),
    z
      .object({
        minutes_since_presented_to_at_least: z.object({ suspect: IdSchema, minutes: z.number().min(0) }).strict(),
      })
      .strict(),
    z.object({ hint_given: IdSchema }).strict(),
    z
      .object({
        hint_given_minutes_ago_at_least: z.object({ hint: IdSchema, minutes: z.number().min(0) }).strict(),
      })
      .strict(),
    z.object({ accusation_submitted: z.literal(true) }).strict(),
    z.object({ accused: IdSchema }).strict(),
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z.object({ at_least: z.object({ n: z.number().int().min(1), of: z.array(ConditionSchema) }).strict() }).strict(),
  ]),
);

const ALWAYS: Condition = { always: true };

/** A lie the suspect is authorised to tell, and when to tell it. */
export const LieSchema = z
  .object({
    text: z.string().min(1),
    /** When the suspect tells it, e.g. "when asked about your shoes". Omitted: whenever the topic comes up. */
    when: z.string().min(1).optional(),
  })
  .strict();

/** What a suspect may say on one testimony thread while that thread is in this state. */
export const ThreadStateSchema = z
  .object({
    id: IdSchema,
    /** True facts the suspect may state in this state. */
    facts: z.array(z.string().min(1)).default([]),
    /** Topics the suspect will not discuss in this state. They deflect or use an authorised lie. */
    keep_quiet: z.array(z.string().min(1)).default([]),
    /** Lies in force in this state. Told the same way every time until a transition replaces them. */
    authorised_lies: z.array(LieSchema).default([]),
  })
  .strict();

/** One line of testimony. It starts in `initial_state` and only moves forward. */
export const ThreadSchema = z
  .object({
    id: IdSchema,
    initial_state: IdSchema,
    states: z.array(ThreadStateSchema).min(1),
  })
  .strict();

/** An authored reaction to a presented card that fires no transition. First match wins. */
export const ReactionSchema = z
  .object({
    evidence_id: IdSchema,
    when: ConditionSchema.default(ALWAYS),
    line: z.string().min(1),
  })
  .strict();

/** A fixed line for a situation the player creates in free text, such as a forceful accusation. */
export const SituationalLineSchema = z
  .object({
    id: IdSchema,
    /** What the player says or does, for the model. */
    cue: z.string().min(1),
    /** Lower-case phrases the simulated adapter matches in the player's message. */
    keywords: z.array(z.string().min(1)).min(1),
    when: ConditionSchema.default(ALWAYS),
    line: z.string().min(1),
  })
  .strict();

export const SuspectSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    age: z.number().int().min(0),
    role: z.string().min(1),
    /** Shown to every player. */
    public_description: z.string().min(1),
    /** Private: given to the model as the character brief. */
    persona: z.string().min(1),
    /** Private: how the character speaks. */
    voice: z.string().min(1),
    voice_examples: z.array(z.string().min(1)).default([]),
    /** The suspect's first account, given on a player's first interview turn. */
    first_account: z.string().min(1),
    /** True facts the suspect may state in any state. */
    knows: z.array(z.string().min(1)).default([]),
    /** True facts the suspect does not raise, but gives when asked directly about the topic. */
    not_volunteered: z.array(z.string().min(1)).default([]),
    /** Things the suspect believes. Said as opinion. */
    believes: z.array(z.string().min(1)).default([]),
    /** A secret unrelated to the murder (a red herring), and the transition that brings it out. */
    unrelated_secret: z
      .object({ text: z.string().min(1), revealed_by: IdSchema })
      .strict()
      .optional(),
    threads: z.array(ThreadSchema).min(1),
    reactions: z.array(ReactionSchema).default([]),
    /** Said when a card that already fired a transition for this suspect is shown again. */
    already_told_line: z.string().min(1).optional(),
    /** Said when a card has no reaction and no transition. Never says the card is useless. */
    default_line: z.string().min(1),
    /** The in-character "I don't know", for anything outside what the suspect may say. */
    dont_know_line: z.string().min(1),
    situational_lines: z.array(SituationalLineSchema).default([]),
  })
  .strict();

/** A fact some suspects share because they saw or heard it at the dinner. */
export const SharedKnowledgeSchema = z
  .object({
    text: z.string().min(1),
    known_by: z.array(IdSchema).min(1),
  })
  .strict();

/** A visible action at a location. Performing it yields the evidence that names it. */
export const LocationActionSchema = z
  .object({
    id: IdSchema,
    label: z.string().min(1),
    unlock: ConditionSchema.default(ALWAYS),
    /** Narration returned to the player who performs the action. */
    text: z.string().min(1),
  })
  .strict();

export const LocationSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /** Shown when the location is available. */
    description: z.string().min(1),
    unlock: ConditionSchema.default(ALWAYS),
    actions: z.array(LocationActionSchema).min(1),
  })
  .strict();

export const DiscoverySchema = z
  .object({
    action: z.literal('inspect'),
    location_id: IdSchema,
    action_id: IdSchema,
  })
  .strict();

export const EvidenceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /** The card text a player sees once they hold the evidence. */
    description: z.string().min(1),
    discovery: DiscoverySchema,
    unlock: ConditionSchema.default(ALWAYS),
    /** Narration shown to the discovering player. */
    found_text: z.string().min(1),
  })
  .strict();

/**
 * `(suspect, thread, from_state, evidence, min_act, requires) -> to_state`. Fires at most once per
 * game, and at most one transition fires per presentation.
 */
export const TransitionSchema = z
  .object({
    id: IdSchema,
    suspect_id: IdSchema,
    thread_id: IdSchema,
    from_state: IdSchema,
    evidence_id: IdSchema,
    min_act: z.number().int().min(1).default(1),
    /** An extra condition, e.g. which route reached the from-state. */
    requires: ConditionSchema.default(ALWAYS),
    to_state: IdSchema,
    /** Other threads of the same suspect that move with this transition. */
    also_set: z.array(z.object({ thread_id: IdSchema, state: IdSchema }).strict()).default([]),
    /** Direction for the model on how the suspect reacts in the moment. */
    reaction: z.string().min(1),
    /** What the suspect's account now says, in the author's words. */
    account: z.string().min(1),
  })
  .strict();

export const ActSchema = z
  .object({
    number: z.number().int().min(1),
    name: z.string().min(1),
    /** Shown when the act starts. Atmosphere only; no new facts. */
    intro: z.string().min(1),
    /** When this holds, the game moves to the next act without the host. Omit for manual only. */
    auto_advance: ConditionSchema.optional(),
    /** When this holds, the game master may tell the host the group looks ready for the next act. */
    suggest_advance: ConditionSchema.optional(),
  })
  .strict();

export const HintSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    /** Alternative texts; the first whose condition holds replaces `text`. */
    variants: z.array(z.object({ when: ConditionSchema, text: z.string().min(1) }).strict()).default([]),
    /** When the game master may deliver it. Hints are also delivered in list order. */
    condition: ConditionSchema,
  })
  .strict();

export const AtmosphericEventSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    condition: ConditionSchema.default(ALWAYS),
  })
  .strict();

/** Other authored game-master interventions: highlight a location, or a one-off notice. */
export const GmInterventionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('highlight_location'),
      location_id: IdSchema,
      text: z.string().min(1),
      condition: ConditionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('notice'),
      id: IdSchema,
      text: z.string().min(1),
      condition: ConditionSchema,
    })
    .strict(),
]);

export const VerdictSchema = z.enum(['solved', 'thin', 'unsolved']);

/** An accusation outcome. Outcomes are checked in order; the first that matches applies. */
export const OutcomeSchema = z
  .object({
    id: IdSchema,
    verdict: VerdictSchema,
    title: z.string().min(1),
    text: z.string().min(1),
    /** The accused suspect must be this one. Omitted: anyone. */
    suspect_id: IdSchema.optional(),
    /** Every one of these must be cited. */
    cites_all: z.array(IdSchema).default([]),
    /** At least one of these must be cited (when non-empty). */
    cites_any: z.array(IdSchema).default([]),
  })
  .strict();

export const AccusationRulesSchema = z
  .object({
    min_act: z.number().int().min(1),
    max_evidence: z.number().int().min(1),
    outcomes: z.array(OutcomeSchema).min(1),
    /** Shown when the investigation ends with no accusation. */
    none_text: z.string().min(1),
  })
  .strict();

export const SolutionSchema = z
  .object({
    killer_suspect_id: IdSchema,
    /** One paragraph: who, where, how and why. */
    summary: z.string().min(1),
    motive: z.string().min(1),
    method: z.string().min(1),
    /** What each key clue means. */
    clues: z.array(z.object({ title: z.string().min(1), text: z.string().min(1) }).strict()).min(1),
    /** Read at the reveal. */
    narration: z.string().min(1),
  })
  .strict();

/** A trail that points away from the killer. "Followed" is derived from what the group did. */
export const RedHerringSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    text: z.string().min(1),
    followed_when: ConditionSchema,
  })
  .strict();

const CaseObjectSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    /** Public scene-setting shown in the lobby. */
    intro: z.string().min(1),
    /** Public lodge layout, shown on the player map. */
    layout: z.string().min(1),
    acts: z.array(ActSchema).min(1),
    shared_knowledge: z.array(SharedKnowledgeSchema).default([]),
    suspects: z.array(SuspectSchema).min(1),
    locations: z.array(LocationSchema).min(1),
    evidence: z.array(EvidenceSchema).min(1),
    transitions: z.array(TransitionSchema),
    hints: z.array(HintSchema).default([]),
    atmospheric_events: z.array(AtmosphericEventSchema).default([]),
    gm_interventions: z.array(GmInterventionSchema).default([]),
    accusation: AccusationRulesSchema,
    solution: SolutionSchema,
    red_herrings: z.array(RedHerringSchema).default([]),
  })
  .strict();

export type CaseFile = z.infer<typeof CaseObjectSchema>;
export type Suspect = z.infer<typeof SuspectSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ThreadState = z.infer<typeof ThreadStateSchema>;
export type Lie = z.infer<typeof LieSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type LocationAction = z.infer<typeof LocationActionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Act = z.infer<typeof ActSchema>;
export type Hint = z.infer<typeof HintSchema>;
export type AtmosphericEvent = z.infer<typeof AtmosphericEventSchema>;
export type GmIntervention = z.infer<typeof GmInterventionSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
export type RedHerring = z.infer<typeof RedHerringSchema>;

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

function conditionRefs(c: Condition, out: { kind: string; id: string }[] = []) {
  if ('evidence_discovered' in c) out.push({ kind: 'evidence', id: c.evidence_discovered });
  else if ('evidence_shared' in c) out.push({ kind: 'evidence', id: c.evidence_shared });
  else if ('evidence_presented' in c) {
    out.push({ kind: 'suspect', id: c.evidence_presented.suspect });
    out.push({ kind: 'evidence', id: c.evidence_presented.evidence });
  } else if ('location_visited' in c) out.push({ kind: 'location', id: c.location_visited });
  else if ('transition_fired' in c) out.push({ kind: 'transition', id: c.transition_fired });
  else if ('hint_given' in c) out.push({ kind: 'hint', id: c.hint_given });
  else if ('hint_given_minutes_ago_at_least' in c)
    out.push({ kind: 'hint', id: c.hint_given_minutes_ago_at_least.hint });
  else if ('minutes_since_presented_to_at_least' in c)
    out.push({ kind: 'suspect', id: c.minutes_since_presented_to_at_least.suspect });
  else if ('accused' in c) out.push({ kind: 'suspect', id: c.accused });
  else if ('suspect_in_state' in c) {
    out.push({ kind: 'suspect', id: c.suspect_in_state.suspect });
    out.push({ kind: `state:${c.suspect_in_state.suspect}`, id: c.suspect_in_state.state });
  } else if ('all' in c) c.all.forEach((x) => conditionRefs(x, out));
  else if ('any' in c) c.any.forEach((x) => conditionRefs(x, out));
  else if ('not' in c) conditionRefs(c.not, out);
  else if ('at_least' in c) c.at_least.of.forEach((x) => conditionRefs(x, out));
  return out;
}

/** The case schema, including referential integrity checks across sections. */
export const CaseSchema = CaseObjectSchema.superRefine((c, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) => ctx.addIssue({ code: 'custom', message, path });

  for (const [name, list] of [
    ['suspects', c.suspects],
    ['locations', c.locations],
    ['evidence', c.evidence],
    ['transitions', c.transitions],
    ['hints', c.hints],
    ['atmospheric_events', c.atmospheric_events],
    ['red_herrings', c.red_herrings],
  ] as const) {
    for (const d of duplicates(list.map((x) => x.id))) issue(`duplicate id "${d}"`, [name]);
  }

  c.acts.forEach((a, i) => {
    if (a.number !== i + 1) issue(`acts must be numbered 1..n in order`, ['acts', i, 'number']);
  });

  const suspects = new Map(c.suspects.map((s) => [s.id, s]));
  const known: Record<string, Set<string>> = {
    evidence: new Set(c.evidence.map((e) => e.id)),
    location: new Set(c.locations.map((l) => l.id)),
    transition: new Set(c.transitions.map((t) => t.id)),
    hint: new Set(c.hints.map((h) => h.id)),
    suspect: new Set(suspects.keys()),
  };
  for (const s of c.suspects) known[`state:${s.id}`] = new Set(s.threads.flatMap((t) => t.states.map((st) => st.id)));

  c.suspects.forEach((s, i) => {
    for (const d of duplicates(s.threads.map((t) => t.id)))
      issue(`duplicate thread "${d}"`, ['suspects', i, 'threads']);
    const allStates = s.threads.flatMap((t) => t.states.map((st) => st.id));
    for (const d of duplicates(allStates))
      issue(`duplicate state "${d}" (state ids are unique per suspect)`, ['suspects', i, 'threads']);
    s.threads.forEach((t, j) => {
      if (!t.states.some((st) => st.id === t.initial_state))
        issue(`unknown initial_state "${t.initial_state}"`, ['suspects', i, 'threads', j, 'initial_state']);
    });
    if (s.unrelated_secret && !known.transition!.has(s.unrelated_secret.revealed_by))
      issue(`unknown transition "${s.unrelated_secret.revealed_by}"`, ['suspects', i, 'unrelated_secret']);
    s.reactions.forEach((r, j) => {
      if (!known.evidence!.has(r.evidence_id))
        issue(`unknown evidence "${r.evidence_id}"`, ['suspects', i, 'reactions', j, 'evidence_id']);
    });
  });

  c.shared_knowledge.forEach((k, i) => {
    for (const id of k.known_by)
      if (!suspects.has(id)) issue(`unknown suspect "${id}"`, ['shared_knowledge', i, 'known_by']);
  });

  c.locations.forEach((l, i) => {
    for (const d of duplicates(l.actions.map((a) => a.id))) issue(`duplicate action "${d}"`, ['locations', i]);
  });

  c.evidence.forEach((e, i) => {
    const loc = c.locations.find((l) => l.id === e.discovery.location_id);
    if (!loc) issue(`unknown location "${e.discovery.location_id}"`, ['evidence', i, 'discovery']);
    else if (!loc.actions.some((a) => a.id === e.discovery.action_id))
      issue(`unknown action "${e.discovery.action_id}" at "${loc.id}"`, ['evidence', i, 'discovery']);
  });

  c.transitions.forEach((t, i) => {
    const s = suspects.get(t.suspect_id);
    if (!s) return issue(`unknown suspect "${t.suspect_id}"`, ['transitions', i, 'suspect_id']);
    const thread = s.threads.find((x) => x.id === t.thread_id);
    if (!thread) return issue(`unknown thread "${t.thread_id}"`, ['transitions', i, 'thread_id']);
    const states = new Set(thread.states.map((x) => x.id));
    if (!states.has(t.from_state)) issue(`unknown from_state "${t.from_state}"`, ['transitions', i, 'from_state']);
    if (!states.has(t.to_state)) issue(`unknown to_state "${t.to_state}"`, ['transitions', i, 'to_state']);
    for (const a of t.also_set) {
      const other = s.threads.find((x) => x.id === a.thread_id);
      if (!other) issue(`unknown thread "${a.thread_id}"`, ['transitions', i, 'also_set']);
      else if (!other.states.some((x) => x.id === a.state))
        issue(`unknown state "${a.state}"`, ['transitions', i, 'also_set']);
    }
    if (!known.evidence!.has(t.evidence_id))
      issue(`unknown evidence "${t.evidence_id}"`, ['transitions', i, 'evidence_id']);
    if (t.min_act > c.acts.length)
      issue(`min_act ${t.min_act} exceeds the number of acts`, ['transitions', i, 'min_act']);
  });

  const checkCondition = (cond: Condition | undefined, path: (string | number)[]) => {
    if (!cond) return;
    for (const ref of conditionRefs(cond)) {
      if (!known[ref.kind]?.has(ref.id)) issue(`condition refers to unknown ${ref.kind} "${ref.id}"`, path);
    }
  };
  c.locations.forEach((l, i) => {
    checkCondition(l.unlock, ['locations', i, 'unlock']);
    l.actions.forEach((a, j) => checkCondition(a.unlock, ['locations', i, 'actions', j, 'unlock']));
  });
  c.evidence.forEach((e, i) => checkCondition(e.unlock, ['evidence', i, 'unlock']));
  c.transitions.forEach((t, i) => checkCondition(t.requires, ['transitions', i, 'requires']));
  c.acts.forEach((a, i) => {
    checkCondition(a.auto_advance, ['acts', i, 'auto_advance']);
    checkCondition(a.suggest_advance, ['acts', i, 'suggest_advance']);
  });
  c.hints.forEach((h, i) => {
    checkCondition(h.condition, ['hints', i, 'condition']);
    h.variants.forEach((v, j) => checkCondition(v.when, ['hints', i, 'variants', j]));
  });
  c.atmospheric_events.forEach((e, i) => checkCondition(e.condition, ['atmospheric_events', i, 'condition']));
  c.gm_interventions.forEach((g, i) => {
    checkCondition(g.condition, ['gm_interventions', i, 'condition']);
    if (g.kind === 'highlight_location' && !known.location!.has(g.location_id))
      issue(`unknown location "${g.location_id}"`, ['gm_interventions', i, 'location_id']);
  });
  c.suspects.forEach((s, i) => {
    s.reactions.forEach((r, j) => checkCondition(r.when, ['suspects', i, 'reactions', j, 'when']));
    s.situational_lines.forEach((r, j) => checkCondition(r.when, ['suspects', i, 'situational_lines', j, 'when']));
  });
  c.red_herrings.forEach((r, i) => checkCondition(r.followed_when, ['red_herrings', i, 'followed_when']));

  c.accusation.outcomes.forEach((o, i) => {
    if (o.suspect_id && !suspects.has(o.suspect_id))
      issue(`unknown suspect "${o.suspect_id}"`, ['accusation', 'outcomes', i, 'suspect_id']);
    for (const id of [...o.cites_all, ...o.cites_any])
      if (!known.evidence!.has(id)) issue(`unknown evidence "${id}"`, ['accusation', 'outcomes', i]);
  });
  const last = c.accusation.outcomes.at(-1);
  if (last && (last.suspect_id || last.cites_all.length || last.cites_any.length))
    issue('the last outcome must match any accusation', ['accusation', 'outcomes']);
  if (c.accusation.min_act > c.acts.length) issue('min_act exceeds the number of acts', ['accusation', 'min_act']);

  if (!suspects.has(c.solution.killer_suspect_id))
    issue(`unknown killer "${c.solution.killer_suspect_id}"`, ['solution', 'killer_suspect_id']);
});

/** Parse and validate a case. Throws with a readable list of issues. */
export function parseCase(input: unknown): CaseFile {
  const result = CaseSchema.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid case file:\n${lines.join('\n')}`);
  }
  return result.data;
}
