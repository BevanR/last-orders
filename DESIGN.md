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
   Sprite.
3. The agent claims jobs from `POST /internal/agent/jobs/claim` (bearer `AGENT_SHARED_SECRET`).
   Claim picks the oldest pending job whose `serial_key` (e.g. `game:suspect`) has no running
   job — this serialises replies per suspect — and sets a lease (60s).
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
