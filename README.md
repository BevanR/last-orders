# Last Orders

Last Orders is a murder mystery you play in a browser with friends. A storm has cut off a
lodge on the West Coast of New Zealand. The owner lies dead at the foot of her cellar stairs.
One to six people investigate together. Claude plays the four suspects and a game master. You
search the lodge, question each suspect in private, and show them evidence to break their
stories. A rules engine decides what each suspect knows and when their story changes, so the
case stays fair and the killer never simply confesses. The agent runs on a Fly.io Sprite and
calls Claude through the Sprites Anthropic connector. It is our entry for Fly.io Hacksgiving
2026.

**Play it: https://last-orders.fly.dev**

Open a case, send the invite link to your friends, and start. You need only a name, not an
account. Do not read `case/` in this repository first: it holds the solution.

| | | |
|---|---|---|
| ![The lobby: case brief and "Open a case"](docs/screenshots/01-lobby-desktop.png) | ![The four suspects](docs/screenshots/04-suspects-desktop.png) | ![The host's desk with the "Behind the scenes" panel](docs/screenshots/07-host-desktop.png) |
| The lobby | The four suspects | The host's desk and "Behind the scenes" |

Contents: [How a game works](#how-a-game-works) ·
[Architecture](#architecture) · [Why a Sprite](#why-a-sprite) ·
[How the connector is used](#how-the-connector-is-used) ·
[Things we learned about Sprites](#things-we-learned-about-sprites) · [Cost](#cost) ·
[Development](#development) · [Deploy](#deploy)

## How a game works

1. **Open a case.** One person creates a room and becomes the host. They get an invite link
   for everyone else. The waiting room shows the case brief.
2. **Search the lodge.** Six rooms each have things to inspect. An inspection gives you an
   exhibit card. Your cards are private until you pin them to the shared board.
3. **Interview the four.** Each suspect talks to each player in a private chat. Other players
   do not see your interview. Claude speaks for the suspect, but only from what that suspect
   knows and is allowed to say.
4. **Present evidence.** Show a card to a suspect. If the card contradicts their story, the
   rules engine moves their testimony forward and Claude voices the new account. Each change
   happens once. If the card does not matter to them, they react in character and nothing
   changes.
5. **Get help when stuck.** The AI game master checks on the room about every 90 seconds. When
   the group stalls, it gives an authored hint, points at an unvisited room, or plays a storm
   event. It tells the host when the group looks ready for the next act.
6. **Accuse.** The game has three acts: First Accounts, Contradictions and Accusation. The group
   makes one accusation and cites the evidence for it. Then the host ends the investigation.
7. **The reveal.** Everyone sees what happened, how their accusation scored, and a short
   commentary from Claude on how they played.

The solution never reaches a browser before the host ends the game. It is not in any page,
script or API response. The end-to-end test checks this.

## Architecture

```mermaid
flowchart LR
  subgraph B["Browser (untrusted)"]
    UI["React client<br/>sees only its own redacted view"]
  end

  subgraph F["Fly App last-orders (trusted: holds the case and the solution)"]
    API["Game API + SSE"]
    ENG["Rules engine<br/>facts, unlocks, testimony, scoring"]
    Q["Job queue + dispatcher"]
    INT["Internal agent API<br/>bearer shared secret"]
  end

  DB[("Fly Managed Postgres<br/>state, jobs, event log")]

  subgraph S["Fly Sprite last-orders-gm (semi-trusted: scoped context only)"]
    AG["Agent: POST /wake, job worker,<br/>prompt builder"]
  end

  subgraph C["Sprites Anthropic connector"]
    GW["Gateway adds the API key"]
  end

  CL["Claude"]

  UI <-->|"HTTPS + SSE<br/>session cookie"| API
  API --> ENG
  API --> DB
  Q --> DB
  INT --> DB
  Q -->|"POST /wake (no payload)"| AG
  AG -->|"claim job, get scoped context,<br/>submit result"| INT
  AG -->|"Messages API, no key"| GW
  GW --> CL
```

The same picture in text:

```
Browser ──HTTPS + SSE──> Fly App (game API, rules engine, job queue)  ──SQL──> Managed Postgres
                             │                       ^
                 POST /wake  │                       │ claim / context / result (bearer secret)
                             v                       │
                         Sprite agent ───────────────┘
                             │
                             └──Messages API──> Sprites Anthropic connector ──> Claude
```

Trust boundaries:

- **Browser.** Untrusted. It gets only what the engine's redaction allows for that player:
  public state, its own interviews and finds, and the shared board. It never gets the case
  bible, another suspect's hidden facts, the killer, or the rules for when testimony changes.
- **Fly App.** The only part with database access and the full case. It decides permissions,
  unlocks, act changes, testimony state and accusation scores.
- **Sprite agent.** Never touches SQL. For each job it gets a scoped context: one suspect's
  persona, what that suspect knows in their current state, the lies they may tell, and this
  player's interview so far. It does not see the solution, except for the reveal commentary
  after the game ends. It can change state only by submitting a job result, which the app
  checks against the lease, a schema and the current revision.
- **Connector.** The Sprite holds no Anthropic key. The gateway identifies the Sprite and adds
  the key. Its access policy allows only Sprites whose names start with `last-orders-`.
- **Model output.** Untrusted. It is schema-checked, length-limited and escaped when shown.

The rules engine owns the facts and Claude owns the voice. When a player presents evidence, the
app runs the engine inside the same database transaction. A matching transition changes the
suspect's state and writes a row with a unique key, so it fires exactly once even if two
players present at the same moment. The reply job then asks Claude to say the new account in
character. Every suspect brief forbids confessing and naming a killer. Accusation scoring is
deterministic.

More detail: [DESIGN.md](DESIGN.md) (how the code is shaped) and [PLAN.md](PLAN.md) (decisions
and status).

## Why a Sprite

- **It wakes on demand.** The app sends `POST /wake` to the Sprite's public URL when a job is
  waiting. The request carries no data. The agent then claims jobs from the app until the
  queue is empty.
- **It sleeps when idle.** Most of a murder mystery is people reading and thinking. Between
  questions the Sprite has nothing to do, and it suspends.
- **Game state survives in Postgres.** The Sprite keeps nothing it needs. Jobs have leases. If
  the Sprite sleeps, restarts or loses a job, the app puts the job back in the queue and pings
  again. A finished job that is submitted twice returns the stored result, so no reply appears
  twice.
- **It is a real computer.** Node 24 was already installed. We deploy the agent as one bundled
  file and run it as a Sprite service, `last-orders-agent`, with
  [`infra/sprite/deploy-agent.sh`](infra/sprite/deploy-agent.sh).

## How the connector is used

The agent uses the official `@anthropic-ai/sdk` with `baseURL` set to the connector's gateway:

```
POST https://api.sprites.dev/v1/gateway/anthropic/<connection id>/v1/messages
```

The SDK sends no key and no auth header. The gateway adds the key from the connection, which is
billed to our own Anthropic account. Three kinds of job call Claude (`claude-sonnet-5-5` by
default):

| Job | Input | Output the app accepts |
|---|---|---|
| Suspect reply | One suspect's scoped context and the player's interview | In-character text, up to about 400 tokens |
| Game-master tick | Act, time since the last discovery, what is found, hints already given | One choice id from an allowed list, such as `hint:<id>` or `none` |
| Reveal commentary | The finished game, after the host ends it | Text, always labelled as commentary |

Measured on 26 November 2026, with real Claude replies through the connector:

| Case | Time |
|---|---|
| Suspect reply, Sprite awake | 2.9 s |
| Suspect reply after 16 minutes idle (Sprite boot about 57 s) | 60.6 s |
| Reveal commentary | 4 to 6 s |

To hide the cold start, the app sends one pre-warm ping when a host creates a room and another
when the game starts. Players read the case brief while the Sprite wakes.

## Things we learned about Sprites

Each of these is measured unless it says otherwise. The full log is in
[infra/sprite/FINDINGS.md](infra/sprite/FINDINGS.md).

- **A Sprite suspends when no request to it is open, even mid-job.** Our agent first answered
  `/wake` with 202 and worked in the background. The Sprite then slept during model calls, and
  jobs timed out. The fix: the agent keeps the `/wake` response open, writes a heartbeat line
  every 10 seconds, and closes it when the queue is empty. The app reads it for up to 5
  minutes. After this change, real replies came back reliably.
- **Keep-alive sockets do not survive a suspend.** After a resume, Node reused a pooled
  connection that was dead. Every job claim hung until its timeout. The fix: a 2-second
  keep-alive and one retry on a fresh connection after a timeout or network error.
- **The process survives a sleep.** After a cold wake the agent had the same process id. Memory
  survived. We still keep all state in Postgres, because a restart would lose it.
- **Cold wakes vary.** We saw 5.6 s after 15 minutes idle, about 57 s of boot before a 60.6 s
  reply after 16 minutes idle, and once about 4 minutes. Warm requests take 0.1 to 0.4 s. The
  pre-warm ping waits up to 300 s and never blocks a player.
- **The REST status is not a wake signal.** `GET /v1/sprites/{name}` read `cold` while the
  service answered `/healthz` in 0.2 s. We probe the service URL instead.

## Cost

- **Fly Managed Postgres:** plan `dev-256`, US$4 per 30 days.
- **Fly App:** one `shared-cpu-1x` machine with 512 MB, always on, because the dispatcher runs
  game-master ticks and lease checks.
- **Sprite:** it runs only while a game needs replies, then sleeps. We have not checked this
  against a bill.
- **Claude:** each game has a spend cap, US$3 by default. The agent reports token use for each
  job and the app adds it up. Past the cap, suspects answer from authored lines, labelled
  "simulated", with a notice. The first connector test used about 85 input and 191 output
  tokens, well under US$0.01 (worked out from token counts, not from a bill).
- **Tests:** free. Every automated test uses a simulated model adapter and makes no paid
  calls.

## Repository layout

| Path | What |
|---|---|
| `packages/engine` | Case schema, rules, redaction, scoped contexts. Pure TypeScript. |
| `apps/server` | Fastify app: game API, SSE, job queue, internal agent API. Serves the web build. |
| `apps/agent` | Runs on the Sprite: wake endpoint, job worker, model adapters. |
| `apps/web` | React + Vite client. |
| `case/` | The authored case. **`case/bible.md` and the case JSON contain the solution. Do not read them before you play.** |
| `infra/sprite` | Sprite deploy and ops scripts, and [FINDINGS.md](infra/sprite/FINDINGS.md). |
| `docs/` | Screenshots and [submission material](docs/SUBMISSION.md). |

## Development

### Requirements

- Node 22 and npm 10.
- PostgreSQL 16 on `localhost:5432`.

### Local Postgres

The local setup uses the `postgres` role with the password `postgres`. This password is for a
local development database only.

```bash
pg_ctlcluster 16 main start          # if Postgres is installed but not running
sudo -u postgres psql -c "ALTER ROLE postgres PASSWORD 'postgres'"
sudo -u postgres createdb last_orders
sudo -u postgres createdb last_orders_test
```

The server creates its tables at startup from `apps/server/migrations/*.sql`.

### Install and build

```bash
npm install
npm run build        # engine, agent, server, then web (apps/web/dist)
```

### Run locally with the simulated model

Use three terminals. The simulated adapter makes no model calls; its replies start with
`[simulated]`.

```bash
# 1. App server on :8080
AGENT_SHARED_SECRET=dev-secret AGENT_WAKE_URL=http://localhost:8081/wake COOKIE_INSECURE=1 \
  npm run dev:server

# 2. Agent on :8081
AGENT_SHARED_SECRET=dev-secret APP_URL=http://localhost:8080 MODEL_ADAPTER=simulated \
  npm run dev:agent

# 3. Web client with hot reload on :5173 (proxies /api to :8080)
npm run dev:web
```

Open http://localhost:5173, create a room, and open the invite link in a second browser profile
or a private window to play as a second player. After `npm run build`, the server also serves the
built client at http://localhost:8080.

`COOKIE_INSECURE=1` lets the session cookie work over plain `http://`. Leave it unset in
production, where cookies are `Secure`.

To use Claude locally, run the agent with `MODEL_ADAPTER=anthropic` and your own
`ANTHROPIC_API_KEY`. These are paid calls.

### Configuration

Server (`apps/server`):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/last_orders` | Postgres connection. |
| `AGENT_SHARED_SECRET` | (unset) | Bearer secret for `/internal/agent/*`. Unset disables that API. |
| `AGENT_WAKE_URL` | (unset) | Agent wake endpoint. Unset: the server never pings the agent. |
| `CASE_FILE` | `case/last-orders.case.json` | Case to load. Tests use the fixture in `packages/engine/test/fixtures/`. |
| `PORT` | `8080` | HTTP port. |
| `COOKIE_INSECURE` | (unset) | `1` drops the `Secure` cookie flag for local `http://`. |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `DISPATCHER_INTERVAL_MS` | `120`, `3`, `10000` | Job queue tuning. |
| `GM_TICK_SECONDS` | `90` | Seconds between game-master ticks per active game. `0` turns the game master off. |
| `GM_IDLE_MINUTES` | `20` | No game-master ticks once no player has acted for this long. |

Agent (`apps/agent`):

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:8080` | The app server. |
| `AGENT_SHARED_SECRET` | (required) | Same value as the server's. |
| `AGENT_SHARED_SECRET_FILE` | (unset) | A file holding the secret, used instead of `AGENT_SHARED_SECRET` (the Sprite does this). |
| `MODEL_ADAPTER` | `simulated` | `simulated` or `anthropic`. |
| `MODEL` | `claude-sonnet-5-5` | Model for the `anthropic` adapter. |
| `ANTHROPIC_BASE_URL` | (SDK default) | The Sprites gateway URL in production. |
| `ANTHROPIC_API_KEY` | (unset) | Only for direct API use. Unset: no auth header is sent, for the gateway. |
| `PORT` | `8081` | Wake server port. |

### Tests

```bash
npm test             # engine and agent unit tests, server integration tests
```

The server tests need the `last_orders_test` database; set `TEST_DATABASE_URL` to use another
one. They empty its game tables on each test. No test calls a model.

The end-to-end test drives two Chromium contexts through the whole case, from first accounts to the
reveal, against the built server and a simulated agent. It also checks that no page, HTML or script
holds the solution before the reveal. Set `E2E_SCREENSHOTS=<dir>` to save screenshots. It needs
Playwright's Chromium (it uses a global `playwright` install if the package is not in the repo) and
the `last_orders` database:

```bash
npm run build
npm run test:e2e
```

### Screenshots

`npm run screenshots` plays a short game with the simulated agent and saves each main view at
375x812 and 1440x900 (device scale 2) to `docs/screenshots/`. It needs the same setup as the
end-to-end test. The committed set was reduced to 256 colours afterwards, except the lobby, to keep
the repository small. The script skips the interview, board, accusation and reveal views, because
they show evidence or the solution. Set `SCREENSHOTS_SPOILERS=1` to save them locally; don't commit
them.

### Suspect evals

Adversarial dialogue checks (invented facts, premature confession, unauthorised knowledge, prompt
injection) live in `apps/agent/evals`. They run with the simulated adapter in `npm test`, and on
their own with:

```bash
npm run eval -w @last-orders/agent
# Real model, paid calls: only on purpose.
EVAL_ALLOW_MODEL_CALLS=1 npm run eval -w @last-orders/agent -- --adapter anthropic --model claude-haiku-5-5
```

## Deploy

Pushes to `main` deploy after CI passes. Nothing deploys from other branches.

| Piece | Where | How |
|---|---|---|
| App + web client | Fly App `last-orders`, region `syd`, one `shared-cpu-1x` 512 MB machine | `.github/workflows/deploy.yml` runs `flyctl deploy --remote-only --ha=false`. The `Dockerfile` builds engine, server and web; migrations run when the server starts. Config is in `fly.toml`. |
| Database | Fly Managed Postgres `last-orders-db`, region `syd`, plan `dev-256` | Attached to the app. The `DATABASE_URL` secret holds the direct endpoint. |
| Agent | Sprite `last-orders-gm` | The same workflow runs `infra/sprite/deploy-agent.sh`: it bundles the agent into one file (`npm run bundle -w @last-orders/agent` → `apps/agent/dist/agent.mjs`), uploads it, and restarts the Sprite service `last-orders-agent`. Verified against the live Sprite on 26 November 2026. Manual Sprite tasks: `.github/workflows/sprite-ops.yml` (see `infra/sprite/FINDINGS.md`). |

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, build, unit and
integration tests against a Postgres 16 service, the agent bundle, the Playwright end-to-end
test (simulated adapter), and a Docker build whose container must answer `GET /healthz`.

Repository secrets. Each deploy job skips with a notice when its secret is missing.

| Secret | Used by |
|---|---|
| `FLY_API_TOKEN` | App deploy. A deploy token for app `last-orders` is enough. |
| `SPRITES_TOKEN` | Agent deploy. A Sprites API token for org `bevan-rudge`. |

Repository variables `AGENT_MODEL` and `AGENT_MODEL_ADAPTER` override the agent's model
(defaults `claude-sonnet-5-5` and `anthropic`).

Runtime settings that are not secrets live in `fly.toml` `[env]`:

- `AGENT_WAKE_URL` is `https://last-orders-gm-bu5ng.sprites.app/wake`. While it is empty the server queues
  jobs but never wakes the agent. Set it to `<Sprite service URL>/wake` and deploy again. The URL
  must answer `POST /wake` without Sprite URL authentication.

`GET /healthz` returns 200 `{"ok":true,"db":"up"}`, or 503 when `SELECT 1` fails or takes over
2 seconds. Fly's health check uses it.

If the first deploy fails its health check with a TLS certificate error in the logs, the MPG
certificate does not verify under node-postgres, which treats `sslmode=require` as
`verify-full`. Appending `&uselibpqcompat=true` to the `DATABASE_URL` secret gives libpq's
meaning instead: encrypted, not verified.

Build and run the image locally:

```bash
docker build -t last-orders .
docker run --rm --network host -e PORT=8080 \
  -e DATABASE_URL=postgres://postgres:postgres@localhost:5432/last_orders last-orders
```
