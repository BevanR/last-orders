# Sprite findings: `last-orders-gm`

Measured 26 November 2026 (UTC) through `.github/workflows/sprite-ops.yml` runs on branch
`infra/sprite-setup`. Run IDs are in brackets; logs are on GitHub Actions.

## Conclusion

- The Anthropic connector works from inside the Sprite. Real `claude-sonnet-5-5` replies came
  back over raw HTTP and through `@anthropic-ai/sdk` (run 45753023189).
- The agent runs on the Sprite as service `last-orders-agent` and answers on its public URL
  (run 45753317907, 45753618843). It survives a sleep: after 15 minutes idle the first
  request took 5.6 s and the same process (same pid) answered (run 45754268931).
- `AGENT_SHARED_SECRET` is staged on Fly and written to the Sprite (run 45753183377).
- Not yet verified: a real game job end to end (app → `POST /wake` → Sprite → app API →
  connector). That needs the next app deploy, which loads the staged secret and the new
  `AGENT_WAKE_URL`.

## Access

| Channel | Result |
|---|---|
| Cloud-session network secret for `api.sprites.dev` | HTTP 401 `{"error":"authentication failed"}`, header `X-Proxy-Error: upstream auth failed`. Not usable on 26 November 2026. |
| GitHub Actions with repo secret `SPRITES_TOKEN` (whitespace stripped) | Works for every endpoint used below. |
| Public Sprite URL from a cloud session (no auth) | Works once `url_settings.auth = public`. |

## Sprite runtime (run 45752872344)

| Item | Value |
|---|---|
| User / home | `sprite` / `/home/sprite` |
| Kernel | Linux 6.12.118-fly x86_64 |
| Node | v24.22.1 at `/.sprite/bin/node` (preinstalled; no install needed) |
| npm | 12.0.2 at `/.sprite/bin/npm` |
| URL | https://last-orders-gm-bu5ng.sprites.app |
| URL auth | was `{"auth":"sprite","private_access":"admins"}`, now `{"auth":"public"}` (run 45753526682) |

## Sprites REST API: shapes seen

- `POST /v1/sprites/{name}/exec?cmd=bash&cmd=-s&stdin=true`, script as the
  `application/octet-stream` body. The response is **framed**, not plain text: each chunk starts
  with a stream byte (`0x01` stdout, `0x02` stderr) and the body ends with `0x03` plus the exit
  code as one byte. `ops.sh` `sprite_sh` strips the framing and returns the exit code.
- `PUT /v1/sprites/{name}/fs/write?path=…&workingDir=/&mode=0600&mkdir=true` returns
  `{"path","size","mode"}`. `mode` is honoured.
- `PUT /v1/sprites/{name}/services/{service}` returns NDJSON progress events, not the service
  object. `GET /v1/sprites/{name}/services/{service}` returns the definition plus
  `state: {name, status, pid, started_at, next_restart_at}`.
- `POST /v1/sprites/{name}/services/{service}/restart` returns NDJSON, including the first
  seconds of the process's stdout.
- `PUT /v1/sprites/{name}` with `{"url_settings":{"auth":"public"}}` returns
  `{name, url, url_settings}`.
- `GET /v1/sprites/{name}` `.status` is **not** a wake signal. It read `cold` while the service
  answered `/healthz` in 0.2 s with an unchanged pid (run 45753618843).

## Connector proof (run 45753023189)

Gateway: `https://api.sprites.dev/v1/gateway/anthropic/yscja5o0A-6UPqpa3IFdig`, called from
inside the Sprite with no auth header.

| Call | HTTP | Time | Result |
|---|---|---|---|
| `POST /v1/messages`, `anthropic-version: 2023-06-01`, Sonnet 5.5, max_tokens 200 | 200 | 5.74 s | 34 in / 75 out tokens (29 thinking). "Evening, stranger, what'll it be, and mind the chalk outline by the dartboard; nobody saw a thing, apparently." |
| Same, `anthropic-version: 2026-10-21` | 200 | 2.34 s | 34 in / 79 out tokens (32 thinking) |
| `GET /v1/models` | 200 | | 15 models; `claude-sonnet-5-5` listed, `claude-haiku-5-5` listed |
| `@anthropic-ai/sdk` 1.14.0, `baseURL` = gateway, `apiKey: "dummy-not-a-key"` | ok | 2.07 s | 17 in / 37 out. "The bar is open." |

- The gateway tolerates the SDK's `x-api-key` header with a dummy value. The agent's adapter can
  use the official SDK unchanged with `ANTHROPIC_BASE_URL` set.
- Response bodies carry the standard Messages fields, plus `usage.output_tokens_details.
  thinking_tokens`, `service_tier`, `inference_geo`, `speed`.
- Spend: about 85 input and 191 output tokens in total, well under US$0.01 (inferred from
  token counts, not from a bill).

## AGENT_SHARED_SECRET (run 45753183377)

- Generated on the runner (`openssl rand -hex 32`), masked with `::add-mask::`, never printed.
- Fly: `flyctl secrets import --stage -a last-orders` (value on stdin). `flyctl secrets list`
  shows `AGENT_SHARED_SECRET`, digest `24a709392d015195`, status `Staged`.
- Sprite: `/home/sprite/.config/last-orders/agent-shared-secret`, mode 600, 64 bytes, owner
  `sprite`.
- The running app machine gets the secret on the next `flyctl deploy` (the Deploy workflow runs
  on push to `main`).

## Agent deploy (run 45753317907)

- `deploy-agent.sh` with `NODE_BIN=/.sprite/bin/node`: bundle 1,417,622 bytes uploaded and
  renamed into place; service defined and restarted.
- Agent stdout after restart:
  - `listening on :8080, adapter anthropic (claude-sonnet-5-5), app https://last-orders.fly.dev`
  - `claim failed: app API 503 agent_api_disabled`. Expected: the app machine does not have
    `AGENT_SHARED_SECRET` yet.
- Service env: `APP_URL`, `AGENT_SHARED_SECRET_FILE`, `ANTHROPIC_BASE_URL` (gateway),
  `MODEL=claude-sonnet-5-5`, `MODEL_ADAPTER=anthropic`, `NODE_ENV`, `PORT=8080`;
  `http_port: 8080`.

## Latency: `GET /healthz` on the public URL

| Case | Source | Requests | Total time |
|---|---|---|---|
| Warm | GitHub runner (run 45754268931) | 8 | 0.057–0.154 s |
| Warm | GitHub runner (run 45753618843) | 8 | 0.17–0.33 s |
| Warm | cloud session | 3 | 0.21–0.43 s |
| **Cold**, after 900 s with no URL traffic | GitHub runner (run 45754268931) | 1 | **5.59 s** (connect 0.12 s, TLS 0.13 s, first byte 5.59 s) |
| Straight after the cold request | GitHub runner | 3 | 0.084–0.103 s |

- Wait before the cold request: 900 s (15 minutes), measured from the last `/healthz` at
  04:17:40 UTC to 04:32:41 UTC. Only REST status calls ran during the wait.
- The service came back by itself after the cold wake: `pid 2355`, `started_at
  2026-11-26T04:08:53Z` before and after. Inferred: the Sprite suspends and resumes the process
  rather than restarting it. In-memory state survives a sleep, but the agent must not rely on
  that (a Sprite restart would lose it).
- REST `.status` during the idle read `cold` at most polls and `warm` at 420 s and 540 s. I
  can't explain the two `warm` readings; nothing sent traffic to the URL then (not verified for
  the Sprite's own background activity).
- I did not measure how soon the Sprite sleeps. The idle timeout is somewhere under 15 minutes.
- `POST /wake`: HTTP 202 `{"accepted":true}` in 0.07–0.18 s warm.
- Effect on the game: the first wake after an idle period adds about 5.5 s before the agent
  starts a drain. The app's wake ping timed out at 5 s, so the first ping after a sleep would
  have aborted. Raised to 15 s in `apps/server/src/dispatcher.ts` on this branch.

## Recommendations

- Use the Sprite ops workflow for Sprite changes until the cloud-session network secret works.
- Keep `NODE_BIN=/.sprite/bin/node`; `ops.sh deploy-agent` detects it.
- After the next app deploy, check the agent's log for a successful claim, then run one real
  game turn to close milestone 2.
- Rotate `AGENT_SHARED_SECRET` with the `secret` task and `force_secret: true`, then deploy the
  app.

## Service redeploys (26 November 2026)

| Situation | `PUT /services/{name}` | What to do |
|---|---|---|
| Same definition, service running or stopped | 200 `{"message":"Service already running with that command, use POST …/restart …"}`; nothing changes (the message says "running" even when stopped) | `POST …/restart` (gives a new pid; starts a stopped service) |
| Changed definition (for example `cmd` `node` vs `/.sprite/bin/node`) | 409 `service with that name already exists with this config, use POST …/restart to restart or replace it entirely with DELETE … then PUT …` | `DELETE`, then `PUT`, then `POST …/start` |

- Deploy run 45757007653 failed with that 409: `deploy.yml` sent `cmd: node`, the service ran
  `/.sprite/bin/node`. `deploy-agent.sh` now defaults `NODE_BIN` to `/.sprite/bin/node`.
- Stopping the service does not clear the 409; the agent was down from about 04:49:30 to
  04:51:20 UTC while I learned that (run 45757604097).
- Verified the replace path (runs 45758003998, 45758145962): 409 → `DELETE` 204 → `PUT` 200,
  and that `PUT` itself starts the new service (NDJSON `started`); the following `start` is a
  no-op. `/healthz` 200 after each. The service now runs `/.sprite/bin/node`, pid 3360.
