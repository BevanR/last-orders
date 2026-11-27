# Last Orders — technical design

The decisions in [PLAN.md](PLAN.md) are fixed; this file says how the code is shaped. Prefer one
coherent, playable case over general architecture.

## Repo layout (npm workspaces, TypeScript, Node 22)

| Path | What |
|---|---|
| `packages/engine` | Pure TS, no I/O. Case schema (zod), rules engine, state transitions, redaction (what each audience may see), scoped-context builders for suspects and the game master. Unit-tested with vitest. |
| `apps/server` | Node HTTP server (Fastify), `pg`, SQL migrations, SSE, player/host auth, job queue, dispatcher, internal agent API. Serves the built web client. Deployed as Fly App `last-orders`. |
| `apps/web` | React + Vite client. Mobile-first. |
| `apps/agent` | Runs on the Sprite. Wake endpoint, job worker, prompt templates, model adapters (Anthropic via connector, simulated), game-master policy. |
| `case/` | Authored case bible (markdown) and `case/last-orders.case.json`, the machine-readable case validated by the engine's zod schema. |
| `infra/` | Sprite setup scripts, Fly config, GitHub Actions. |

## Trust boundaries

- **Browser** sees only what the engine's redaction allows for that player: public state, their
  own interviews, shared board items. Never the case bible, other suspects' hidden facts, the
  killer, or transition triggers. The solution ships only after the host ends the game.
- **App** is the only component with DB access and the full case. It is the authority for
  permissions, unlocks, act transitions, testimony state, and accusation scoring.
- **Sprite agent** receives *scoped context* per job (one suspect's persona, knowledge slice,
  authorised lies, current testimony state, this player's interview history, evidence presented)
  and returns text or a choice from an allowed list. It never sees the solution unless the job is
  the reveal commentary. It cannot write state except by submitting a job result, which the app
  validates.
- **Model output** is untrusted: schema-validated, length-limited, escaped when rendered, never
  executed.

## Rules engine owns facts; the model owns voice

- Testimony changes are deterministic. When a player presents evidence, the app runs the engine
  inside the same DB transaction. If an authored transition matches `(suspect, from_state,
  evidence_id, act >= n)`, the suspect's state changes and a row in `testimony_transitions` is
  inserted with a unique `(game_id, suspect_id, transition_id)`, so it fires exactly once. The
  reply job then tells the agent "transition X fired; say the new account in your voice".
- Each suspect has an authored list of facts available per testimony state, plus authorised
  lies. The model may only assert those. Anything else: "I don't know" in character.
- The killer never confesses. The killer's final state is a revised account, not a confession.
- Accusation scoring is deterministic: correct suspect or not, and which cited evidence is
  critical. Any model commentary is labelled commentary.

## Data model (Postgres)

`case_versions`, `games` (case_version_id, act, status, revision, spend_cents), `players`
(game_id, display_name, session_token_hash, is_host), `suspect_states` (game_id, suspect_id,
state, revision), `testimony_transitions`, `evidence_discoveries` (game_id, evidence_id,
discovered_by, shared_at), `interviews` (game_id, player_id, suspect_id), `messages`
(interview_id, role, text, presented_evidence_id, job_id, simulated bool), `board_items`,
`jobs` (game_id, kind, serial_key, status, lease_token, lease_expires_at, attempts,
idempotency_key unique, input_revision, result), `game_events` (game_id, seq, audience, type,
payload), `accusations`.

- `game_events.audience` is `public`, `player:<id>`, or `host`. SSE streams only events the
  connected player may see, from their `Last-Event-ID` cursor.
- Write state first, then `NOTIFY game_<id>`; SSE handlers `LISTEN` and read from the table.

## Jobs and the Sprite

1. A player action that needs the model is validated, recorded, and a job is inserted in one
   transaction. `idempotency_key` is derived from the triggering row (e.g. message id).
2. The app pings `POST <sprite-url>/wake` (no payload beyond "work exists"). This wakes a cold
   Sprite. The app also sends one pre-warm ping when a host creates a room and when the game
   starts, so the Sprite is awake before the first reply job. A cold wake usually takes about
   5.6 s but once took about 4 minutes (26 November 2026). The pre-warm ping waits up to 300 s,
   never blocks the request, and only one is in flight per app process.
   The agent answers `/wake` with 202 at once but keeps the response open (heartbeat lines)
   until its drain is done, and the app keeps reading it for up to 5 minutes. The Sprite is
   suspended when no request to it is open, even mid model call; the open wake request keeps
   it awake while the agent works.
3. The agent claims jobs from `POST /internal/agent/jobs/claim` (bearer `AGENT_SHARED_SECRET`).
   Claim picks the oldest pending job whose `serial_key` (e.g. `game:suspect`) has no running
   job — this serialises replies per suspect — and sets a lease (120s). The lease covers the
   agent's worst case with margin: two model attempts of at most 30s each (headers and body)
   plus two 10s attempts to report the result, about 80s.
4. The agent fetches scoped context with the job, calls the model, and submits
   `POST /internal/agent/jobs/:id/complete` with the lease token and output.
5. The app validates the lease, the output schema, and that `input_revision` still matches the
   suspect's revision. Stale result → job requeued with fresh context. Completion of an already
   completed job returns the stored result (idempotent; no duplicate messages).
6. A dispatcher in the app (every 10s) requeues expired leases and re-pings the Sprite with
   backoff while pending jobs exist. It also enqueues a `gm_tick` job per active game every
   ~90s.

The agent drains jobs until none remain, then idles; the Sprite sleeps on its own.

## Game master

`gm_tick` context: act, minutes since last discovery or transition, discovered evidence ids,
fired transitions, which locations are unvisited, which hints were already given, and the
authored intervention list with ids. The model returns `{choice_id, reason}`; the app accepts
only ids from the allowed list for the current state (`none`, `hint_1..3` when their conditions
hold, `highlight_location:<id>`, `event:<id>`, `suggest_advance`). Hints and events are authored
text; the model may not add facts.

## Model adapters

- `anthropic`: official `@anthropic-ai/sdk` pointed at the Sprites gateway base URL. Model from
  config (`claude-sonnet-5-5` default). Short outputs (`max_tokens` ~400 for suspects).
- `simulated`: deterministic replies built from the authored facts, prefixed `[simulated]` and
  stored with `messages.simulated = true`. The UI labels them. Used by all automated tests.
- Spend: the agent reports token usage per job; the app converts to cents and stops enqueueing
  model jobs for a game over its cap (default US$3 per game), falling back to simulated replies
  with a visible notice.

## Auth

- Host creates a room → gets a host link (`/h/<host-token>`) and an invite link
  (`/r/<room-code>`). Invite links grant entry, not host rights.
- Opaque session tokens in `HttpOnly; Secure; SameSite=Lax` cookies; DB stores SHA-256 hashes.
- Every read, write and SSE subscription checks game membership and role.
- Rate limits: joins per IP, messages per player per minute, concurrent pending jobs per player.

## Testing

- Engine: vitest unit tests, including a scripted full playthrough of the authored case.
- Server: integration tests against a local Postgres with the simulated adapter.
- E2E: Playwright, three browser contexts, simulated adapter. No paid calls.
- Adversarial dialogue evals (release check, real model, Haiku first): invented facts,
  premature confession, unauthorised knowledge, prompt injection.

## Implementation notes (milestone 3, vertical slice)

Where the slice differs from, or adds detail to, the design above:

- **Locking.** Every transaction that changes a game first takes the `games` row lock (after the
  job row lock, for job completion). This serialises rule decisions per game. It is what makes a
  testimony transition fire once under concurrent presents; the unique
  `(game_id, suspect_id, transition_id)` row is a second guard.
- **Event order.** `game_events.seq` is a per-game counter (`games.event_seq`) bumped under that
  lock, so seq order is commit order and `Last-Event-ID` replay cannot skip an event.
- **NOTIFY.** One channel, `game_events`, with the game id as payload, instead of `game_<id>`
  channels. Each app process holds one `LISTEN` connection and fans out to its SSE streams.
- **Discoveries are per player.** `evidence_discoveries` is unique per `(game, evidence, player)`;
  a find is private until shared to `board_items`. Presentable evidence is the player's own finds
  plus the board.
- **One reply in flight per interview.** A player waits for the suspect's answer before sending
  the next message or presentation (409 `awaiting_reply`). This keeps prompt history in order.
  A player may have at most two pending replies across suspects.
- **Stale replies.** `jobs.input_revision` is set when the job is claimed, which is when its
  context is built. A completion whose suspect revision has moved on is discarded and the job
  requeued.
- **Extra tables.** `location_visits` (for "unvisited locations" and conditions) and
  `game_interventions` (hints given and events fired, for the game master).
- **Cookies.** `Secure` by default; `COOKIE_INSECURE=1` drops the flag for local `http://`.
- **Anthropic adapter.** No `thinking` field (adaptive by default) and `output_config.effort: low`,
  so the same request works for `claude-sonnet-5-5` and `claude-haiku-5-5`. A `refusal` stop
  reason becomes a neutral in-character line. Server-side refusal fallbacks are not enabled
  until the Sprites gateway has been tested with beta headers. Without `ANTHROPIC_API_KEY` the
  adapter sends no auth header, for the gateway to add its own.
- **Not in the slice.** The dispatcher does not enqueue `gm_tick` jobs yet; the engine's game
  master context and allowed-intervention list exist and are tested. Accusations are a table
  only. `CASE_FILE` defaults to the engine's placeholder fixture.

## Implementation notes (milestone 4, the full case)

Where the full case differs from, or adds detail to, the design above:

- **Case file.** `case/last-orders.case.json` is the default `CASE_FILE`; the fixture stays for unit
  tests. Gaps and contradictions patched in the JSON are listed at the end of `case/bible.md`.
- **Testimony threads.** A suspect has one or more threads (for example, one for where they were
  and one for money), each with its own state. `suspect_states` has one row per
  `(game, suspect, thread)`. A transition moves one thread and may move others (`also_set`); it
  can also require a condition (one transition may need another to have fired).
  A reply's staleness check uses the sum of the suspect's thread revisions.
- **Location actions.** Each location has visible actions with their own unlock (the storm hatch
  opens in Act II inside an Act I room). A card comes from exactly one action.
- **Reactions are decided by the engine.** When a card fires nothing, the engine picks the
  authored reaction for the suspect's current state ("already told" or default otherwise) at the
  moment of the presentation and stores it with the job. The model only voices it.
- **The killer's brief holds only what the killer may say.** That suspect's context lists their
  account, lies and the facts of their current state; it never states what they did. Every brief
  forbids confessing and naming a killer.
- **Acts.** Authored `auto_advance` conditions are checked after every player action and on every
  dispatcher pass (timed conditions such as "12 minutes in Act I" are at most one pass late). Only
  the host ends the game; no timer does.
- **Game master.** The dispatcher runs periodic upkeep for every active game. A `gm_tick` is
  enqueued every `GM_TICK_SECONDS` (default 90; 0 turns it off) unless one is open or no player has
  acted for `GM_IDLE_MINUTES` (default 20). The first tick is due one interval after the start.
  The agent returns `{choice_id, reason}`; the app checks the id against the allowed list for the
  state at completion time and applies it at most once (`game_interventions`). Hints are offered
  strictly in order. Choice ids are `hint:<id>`, `highlight_location:<id>`, `notice:<id>`,
  `event:<id>`, `suggest_advance` (stored once per act) and `none`. A suggestion goes to the host
  only. The host can give the next hint by hand; that ignores its delivery condition but keeps
  the order.
- **Accusation.** One per game, for the whole group, because the bible's scoring is for one
  group accusation. Any player submits it, citing cards they hold or the board. It is final and
  closes inspection, interviews and presentations. Its outcome is stored but appears only in the
  reveal, after the host ends the game.
- **Reveal and commentary.** `GameView.reveal` exists only once the game has ended. Ending enqueues
  one `reveal_commentary` job; its text is stored in `games.commentary` and always shown labelled
  as commentary (simulated or AI). A failed commentary job is dropped; the reveal does not need it.
- **Simulated adapter.** Suspects answer only from authored lines: the account on a first turn, the
  transition account, the authored reaction, a situational line on its keywords, the don't-know
  line for injection attempts, and otherwise the authored statement sharing most words with the
  question (or the don't-know line). The simulated game master gives hints first, then the host
  suggestion, notices, highlights, and an atmospheric event in a lull.
- **Evals.** `apps/agent/evals` runs 16 adversarial cases with deterministic checks. CI runs them
  with the simulated adapter only; the anthropic adapter needs `EVAL_ALLOW_MODEL_CALLS=1`.
