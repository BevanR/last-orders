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
| `CASE_FILE` | `packages/engine/test/fixtures/fixture.case.json` | Case to load. The placeholder fixture until the real case exists. |
| `PORT` | `8080` | HTTP port. |
| `COOKIE_INSECURE` | (unset) | `1` drops the `Secure` cookie flag for local `http://`. |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS`, `DISPATCHER_INTERVAL_MS` | `60`, `3`, `10000` | Job queue tuning. |

Agent (`apps/agent`):

| Variable | Default | Meaning |
|---|---|---|
| `APP_URL` | `http://localhost:8080` | The app server. |
| `AGENT_SHARED_SECRET` | (required) | Same value as the server's. |
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

The end-to-end test drives two Chromium contexts through the whole slice against the built server
and a simulated agent. It needs Playwright's Chromium (it uses a global `playwright` install if the
package is not in the repo) and the `last_orders` database:

```bash
npm run build
npm run test:e2e
```
