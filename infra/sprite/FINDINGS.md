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

## Slow wake: Sprite unreachable for about 4 minutes (26 November 2026)

**Conclusion:** the Sprite did not get stuck. It took about 4 minutes to wake from cold, then
recovered by itself with the same process (pid 3360). Nobody had to act on the Sprite. Re-running
the failed deploy job then worked.

Timeline (UTC), measured:

| Time | Event | Source |
|---|---|---|
| 04:54:52 | Agent service started, pid 3360 | sprite-ops run 45758145962 |
| 05:00:46 | REST status `cold`; bundle upload (`PUT fs/write`) starts | Deploy run 45758676416 |
| 05:01:48 | Upload returns **502** after 62 s; job fails before rename/define/restart | same |
| 05:02:29–05:04:52 | 4 × `GET /healthz` on the public URL, each timed out at 30 s (HTTP 000) | lead session |
| 05:05:08–05:05:33 | `GET /healthz` → **200 after 24.6 s** | this session |
| 05:05:35 | `GET /healthz` × 3 → 200 in 0.17–0.19 s | this session |
| 05:05:51 | REST status `warm`; service running, **pid 3360 unchanged**; exec works; no partial `agent.mjs.new` left | sprite-ops run 45759329153 |
| 05:06:55–05:06:58 | Deploy job re-run: upload OK, PUT 200, restart → pid 4104 | Deploy run 45758676416 attempt 2 |
| 05:08 | `GET /healthz` → 200 in 0.40–0.48 s | this session |

- status.flyio.net at 05:05: "All Systems Operational", no incidents.
- Earlier cold wakes took 5.6 s (after 15 minutes idle). This one took about 4 minutes. I don't
  know why; inferred causes are host-side (restore from checkpoint, placement). Not verified.
- The wake kept the process: same pid before and after, so in-memory state survived.

Recovery steps:

1. Wait. Probe `GET <sprite-url>/healthz` with a timeout of 60 s or more, every 30 s.
2. When it answers, run sprite-ops `check`: status `warm`, service `running`, exec works.
3. Re-run the failed deploy job (`rerun_failed_jobs` on the Deploy run).
4. Do not destroy or recreate the Sprite for a slow wake.

Changes:

- `deploy-agent.sh` now wakes the Sprite with `POST /exec?cmd=true` (60 s timeout, up to 12 tries
  15 s apart, about 15 minutes in all) before it uploads. This is not yet tested against a slow
  wake: I couldn't reproduce one.

For the demo:

- Warm the Sprite a few minutes before: `curl -m 300 <sprite-url>/healthz`.
- The app's wake ping has a 15 s timeout. A 4-minute wake means the first pings fail, and the
  dispatcher retries with backoff (inferred from `apps/server/src/dispatcher.ts`; not tested
  against a slow wake). Players would wait for the first reply.

## Claims hang after a Sprite suspend (26 November 2026)

**Conclusion:** the agent's claims never reached the app. A long-lived process reused a
keep-alive connection that went dead across a Sprite suspend/resume, so every claim hung until
its 15 s timeout. Fixed in `apps/agent/src/worker.ts`: a dedicated undici dispatcher with a 2 s
keep-alive, and one retry on a fresh connection after a timeout or network error.

Evidence (measured; sprite-ops `logs` and `probe` tasks, runs 45761992354, 45762465608):
- Agent log: `claim failed: The operation was aborted due to timeout` on every claim from
  05:09:50 to 05:30:18 UTC (pid 4104, started 05:06:58).
- Fly app log (buffer 05:24:55–05:29:01): no `/internal/agent` requests, while the agent
  claimed at 05:26:58, 05:27:07 and 05:28:25.
- From the Sprite, curl and a fresh `node` `fetch` reach `/internal/agent/jobs/claim` (401
  without auth) in 0.2–1 s. Sprite network policy: no rules.
- pid 4104 held one ESTABLISHED socket to `2a09:8280:1::99:d7b3:0`; the app resolves to
  `2a09:8280:1::222:728b:0`. Which host the stuck socket points to is not verified.

Ruled out: a broken job blocking the queue (a failing context build would be a fast, logged
500) and a secret mismatch (that would be a fast 401).

Recovery without the fix: restart the agent service (any agent deploy does).

## Model calls and claims stall: the Sprite sleeps mid-drain (26 November 2026)

**Conclusion (inferred, strong):** the Sprite is suspended while the agent is still working.
The agent answered `POST /wake` with 202 and drained in the background, so no request to the
Sprite was open during claims, model calls or result posts. Each app wake ping (every ~60 s at
max backoff) resumed the Sprite for a moment: pending timers fired at once ("aborted due to
timeout"), the retry was sent, and the Sprite slept again before it was answered. Not the
undici dispatcher of PR #6: job 6 (`reveal_commentary`) completed through it at 05:51:14, 3 s
after the deploy.

Evidence (measured; sprite-ops runs 45765901649 `logs`, 45766131381 `clock`):
- pid 5134 (started 05:51:10): from 05:51:49 every claim timed out, then its retry too. The
  gaps between "retrying on a fresh connection" and the retry's timeout (10 s timer) were
  2.5–71 s, and the claim failures came ~70 s apart: the wake ping cadence (60 s backoff cap +
  10 s dispatcher tick), not the agent's own timers.
- Job 8: `model request failed (Request timed out.); retrying` 05:56:44, `job 8 failed:
  Request timed out.` 05:57:17, then both `/fail` posts timed out (05:57:52, 05:58:27). The app
  posted "No answer came" at 05:56:57 after 3 lease expiries (lease 60 s; ~104 s per attempt).
- Same pattern before PR #6 with the global fetch: `job 4 failed: Request timed out.` 05:39:49.
- Clock: at 06:08:31 the host said pid 5134 had run 1,041 s; inside the VM its elapsed time was
  2,704 s (`ps etimes`). The guest's boot clock ran 1,662 s ahead of wall time in 17 minutes:
  the VM's clocks are discontinuous, as after repeated snapshot/restore. Guest wall clock also
  lagged the service log's host stamps by up to 1.6 s (05:14:10).
- Runs that worked (04:48, 04:51, 05:51:14) were all within seconds of a deploy, while the
  deploy's own exec/REST traffic kept the Sprite awake.

Second gap, fixed too: the SDK timeout stops at the response headers, so a body that stalls
hung the job until its lease expired; and the agent's worst case (2 × 30 s model + 2 × 10 s
result post ≈ 80 s) did not fit the 60 s lease.

Fix (branch `fix/agent-model-calls`): `/wake` answers 202 at once but keeps the response open
(heartbeat line every 10 s) until the drain ends; the app reads it for up to 5 minutes. Model
attempts get a 30 s deadline covering the body. Lease default 120 s.

Not verified: that an open request through the Sprite URL keeps the Sprite awake (Sprites'
idle rule is not documented here), and whether the Sprite proxy streams or buffers the held
response (the app keeps the request open either way). Check after deploy: one real question
answered, and agent log with no "aborted due to timeout" during a drain.
