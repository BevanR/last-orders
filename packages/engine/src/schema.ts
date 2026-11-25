import { z } from 'zod';

/** Lower-case slug used for every authored id. */
export const IdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'ids are lower-case slugs: a-z, 0-9, "_" and "-"');

/**
 * A condition over game state. Conditions gate locations, evidence, act advances, hints and
 * atmospheric events. They are evaluated by `evaluateCondition` in conditions.ts.
 */
export type Condition =
  | { always: true }
  | { act_at_least: number }
  | { evidence_discovered: string }
  | { evidence_shared: string }
  | { location_visited: string }
  | { transition_fired: string }
  | { suspect_in_state: { suspect: string; state: string } }
  | { minutes_since_progress_at_least: number }
  | { hint_given: string }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ always: z.literal(true) }).strict(),
    z.object({ act_at_least: z.number().int().min(1) }).strict(),
    z.object({ evidence_discovered: IdSchema }).strict(),
    z.object({ evidence_shared: IdSchema }).strict(),
    z.object({ location_visited: IdSchema }).strict(),
    z.object({ transition_fired: IdSchema }).strict(),
    z
      .object({ suspect_in_state: z.object({ suspect: IdSchema, state: IdSchema }).strict() })
      .strict(),
    z.object({ minutes_since_progress_at_least: z.number().min(0) }).strict(),
    z.object({ hint_given: IdSchema }).strict(),
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
  ]),
);

const ALWAYS: Condition = { always: true };

export const FactSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
  })
  .strict();

/** What a suspect knows and may say while in one testimony state. */
export const TestimonyStateSchema = z
  .object({
    id: IdSchema,
    /** The suspect's account of events in this state, in the author's words. */
    account: z.string().min(1),
    /** Facts the suspect may assert truthfully in this state. */
    facts: z.array(FactSchema),
    /** Lies the suspect is authorised to tell in this state. Nothing else may be invented. */
    authorised_lies: z.array(FactSchema).default([]),
  })
  .strict();

export const SuspectSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    role: z.string().min(1),
    /** Shown to every player. */
    public_description: z.string().min(1),
    /** Private: given to the model as the character brief. */
    persona: z.string().min(1),
    /** Private: how the character speaks. */
    voice: z.string().min(1),
    initial_state: IdSchema,
    states: z.array(TestimonyStateSchema).min(1),
    /** A secret unrelated to the murder that the suspect guards (a red herring). */
    unrelated_secret: z.string().min(1),
  })
  .strict();

export const LocationSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1),
    /** Shown when the location is available. */
    description: z.string().min(1),
    unlock: ConditionSchema.default(ALWAYS),
    /** Narration returned when a player inspects the location. */
    inspect_text: z.string().min(1),
  })
  .strict();

export const DiscoverySchema = z.discriminatedUnion('action', [
  /** Found by inspecting a location once `unlock` holds. */
  z.object({ action: z.literal('inspect'), location_id: IdSchema }).strict(),
  /** Handed over by a suspect when the given transition fires. */
  z.object({ action: z.literal('transition'), transition_id: IdSchema }).strict(),
]);

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

/** `(suspect, from_state, evidence, min_act) -> to_state`. Fires at most once per game. */
export const TransitionSchema = z
  .object({
    id: IdSchema,
    suspect_id: IdSchema,
    from_state: IdSchema,
    evidence_id: IdSchema,
    min_act: z.number().int().min(1).default(1),
    to_state: IdSchema,
    /** Direction for the model on how the suspect reacts in the moment. */
    reaction: z.string().min(1),
  })
  .strict();

export const ActSchema = z
  .object({
    number: z.number().int().min(1),
    name: z.string().min(1),
    intro: z.string().min(1),
    /** When this holds, the game moves to the next act without the host. Omit for manual only. */
    auto_advance: ConditionSchema.optional(),
  })
  .strict();

export const HintSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    condition: ConditionSchema,
  })
  .strict();

export const AtmosphericEventSchema = z
  .object({
    id: IdSchema,
    text: z.string().min(1),
    condition: ConditionSchema,
  })
  .strict();

export const SolutionSchema = z
  .object({
    killer_suspect_id: IdSchema,
    motive: z.string().min(1),
    method: z.string().min(1),
    critical_evidence_ids: z.array(IdSchema).min(1),
    explanation: z.string().min(1),
  })
  .strict();

const CaseObjectSchema = z
  .object({
    id: IdSchema,
    title: z.string().min(1),
    /** Public scene-setting shown in the lobby. */
    intro: z.string().min(1),
    acts: z.array(ActSchema).min(1),
    suspects: z.array(SuspectSchema).min(1),
    locations: z.array(LocationSchema).min(1),
    evidence: z.array(EvidenceSchema).min(1),
    transitions: z.array(TransitionSchema),
    hints: z.array(HintSchema).default([]),
    atmospheric_events: z.array(AtmosphericEventSchema).default([]),
    solution: SolutionSchema,
  })
  .strict();

export type CaseFile = z.infer<typeof CaseObjectSchema>;
export type Suspect = z.infer<typeof SuspectSchema>;
export type TestimonyState = z.infer<typeof TestimonyStateSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type Act = z.infer<typeof ActSchema>;
export type Hint = z.infer<typeof HintSchema>;
export type AtmosphericEvent = z.infer<typeof AtmosphericEventSchema>;
export type Solution = z.infer<typeof SolutionSchema>;

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
  else if ('location_visited' in c) out.push({ kind: 'location', id: c.location_visited });
  else if ('transition_fired' in c) out.push({ kind: 'transition', id: c.transition_fired });
  else if ('hint_given' in c) out.push({ kind: 'hint', id: c.hint_given });
  else if ('suspect_in_state' in c) {
    out.push({ kind: 'suspect', id: c.suspect_in_state.suspect });
    out.push({ kind: `state:${c.suspect_in_state.suspect}`, id: c.suspect_in_state.state });
  } else if ('all' in c) c.all.forEach((x) => conditionRefs(x, out));
  else if ('any' in c) c.any.forEach((x) => conditionRefs(x, out));
  else if ('not' in c) conditionRefs(c.not, out);
  return out;
}

/** The case schema, including referential integrity checks across sections. */
export const CaseSchema = CaseObjectSchema.superRefine((c, ctx) => {
  const issue = (message: string, path: (string | number)[] = []) =>
    ctx.addIssue({ code: 'custom', message, path });

  for (const [name, list] of [
    ['suspects', c.suspects],
    ['locations', c.locations],
    ['evidence', c.evidence],
    ['transitions', c.transitions],
    ['hints', c.hints],
    ['atmospheric_events', c.atmospheric_events],
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
  for (const s of c.suspects) known[`state:${s.id}`] = new Set(s.states.map((st) => st.id));

  c.suspects.forEach((s, i) => {
    for (const d of duplicates(s.states.map((st) => st.id)))
      issue(`duplicate state "${d}"`, ['suspects', i, 'states']);
    if (!known[`state:${s.id}`]!.has(s.initial_state))
      issue(`unknown initial_state "${s.initial_state}"`, ['suspects', i, 'initial_state']);
  });

  c.evidence.forEach((e, i) => {
    if (e.discovery.action === 'inspect' && !known.location!.has(e.discovery.location_id))
      issue(`unknown location "${e.discovery.location_id}"`, ['evidence', i, 'discovery']);
    if (e.discovery.action === 'transition' && !known.transition!.has(e.discovery.transition_id))
      issue(`unknown transition "${e.discovery.transition_id}"`, ['evidence', i, 'discovery']);
  });

  c.transitions.forEach((t, i) => {
    const s = suspects.get(t.suspect_id);
    if (!s) return issue(`unknown suspect "${t.suspect_id}"`, ['transitions', i, 'suspect_id']);
    const states = known[`state:${s.id}`]!;
    if (!states.has(t.from_state))
      issue(`unknown from_state "${t.from_state}"`, ['transitions', i, 'from_state']);
    if (!states.has(t.to_state))
      issue(`unknown to_state "${t.to_state}"`, ['transitions', i, 'to_state']);
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
  c.locations.forEach((l, i) => checkCondition(l.unlock, ['locations', i, 'unlock']));
  c.evidence.forEach((e, i) => checkCondition(e.unlock, ['evidence', i, 'unlock']));
  c.acts.forEach((a, i) => checkCondition(a.auto_advance, ['acts', i, 'auto_advance']));
  c.hints.forEach((h, i) => checkCondition(h.condition, ['hints', i, 'condition']));
  c.atmospheric_events.forEach((e, i) =>
    checkCondition(e.condition, ['atmospheric_events', i, 'condition']),
  );

  if (!suspects.has(c.solution.killer_suspect_id))
    issue(`unknown killer "${c.solution.killer_suspect_id}"`, ['solution', 'killer_suspect_id']);
  for (const id of c.solution.critical_evidence_ids)
    if (!known.evidence!.has(id)) issue(`unknown evidence "${id}"`, ['solution', 'critical_evidence_ids']);
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
