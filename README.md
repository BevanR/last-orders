# Last Orders

A multiplayer murder mystery for Fly.io Hacksgiving 2026. Humans investigate; AI plays the
suspects. See [PLAN.md](PLAN.md) for decisions and status, and [DESIGN.md](DESIGN.md) for how the
code is shaped.

| Path | What |
|---|---|
| `packages/engine` | Case schema, rules, redaction, scoped contexts. Pure TypeScript. |
| `apps/server` | Fastify app: game API, SSE, job queue, internal agent API. Serves the web build. |
| `apps/agent` | Runs on the Sprite: wake endpoint, job worker, model adapters. |
| `apps/web` | React + Vite client. |

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
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `DISPATCHER_INTERVAL_MS` | `60`, `3`, `10000` | Job queue tuning. |
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
holds the solution before the reveal. Set `E2E_SCREENSHOTS=<dir>` to save screenshots. It needs Playwright's Chromium (it uses a global `playwright` install if the
package is not in the repo) and the `last_orders` database:

```bash
npm run build
npm run test:e2e
```

### Screenshots

`npm run screenshots` plays a short game with the simulated agent and saves each main view at
375x812 and 1440x900 (device scale 2) to `docs/screenshots/`. It needs the same setup as the
end-to-end test. The committed set was reduced to 256 colours afterwards, except the lobby, to keep
the repository small.

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
| Agent | Sprite `last-orders-gm` | The same workflow runs `infra/sprite/deploy-agent.sh`: it bundles the agent into one file (`npm run bundle -w @last-orders/agent` → `apps/agent/dist/agent.mjs`), uploads it, and restarts the Sprite service `last-orders-agent`. Untested against the live Sprites API. |

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

Runtime settings that are not secrets live in `fly.toml` `[env]`. One needs a value later:

- `AGENT_WAKE_URL` is empty until the Sprite's URL is known. While it is empty the server queues
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

