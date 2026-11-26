#!/usr/bin/env bash
# One-off and repeatable operations on the Sprite `last-orders-gm`, through the Sprites REST API
# (https://api.sprites.dev, spec at /openapi.json). Run by .github/workflows/sprite-ops.yml,
# which has the SPRITES_TOKEN and FLY_API_TOKEN repo secrets.
#
# Usage: bash infra/sprite/ops.sh <task>
#   check            Sprite status, URL settings, services, Node version on the Sprite
#   setup            install Node 22 on the Sprite if `node` is missing or older than 22
#   connector-proof  real model calls through the Anthropic connector, from inside the Sprite
#   secret           generate AGENT_SHARED_SECRET, stage it as a Fly app secret, write it to the
#                    Sprite (mode 600). Skips when both already exist, unless FORCE_SECRET=1.
#   deploy-agent     run infra/sprite/deploy-agent.sh
#   public           set the Sprite URL to public (url_settings.auth = public)
#   measure          GET /healthz on the Sprite URL: warm, then cold after the Sprite sleeps
#   all              setup, secret, deploy-agent, public, check
#
# Never prints a token or the shared secret. Anything derived from a secret is masked in
# GitHub Actions logs with ::add-mask:: before use.
set -euo pipefail

API="${SPRITES_API:-https://api.sprites.dev}"
SPRITE_NAME="${SPRITE_NAME:-last-orders-gm}"
FLY_APP="${FLY_APP:-last-orders}"
SERVICE_NAME="${SERVICE_NAME:-last-orders-agent}"
AGENT_SECRET_FILE="${AGENT_SECRET_FILE:-/home/sprite/.config/last-orders/agent-shared-secret}"
GATEWAY="${GATEWAY:-https://api.sprites.dev/v1/gateway/anthropic/yscja5o0A-6UPqpa3IFdig}"
SPRITE="$API/v1/sprites/$SPRITE_NAME"

# Same whitespace strip as deploy-agent.sh: a trailing newline in the secret breaks the header.
SPRITES_TOKEN="$(printf '%s' "${SPRITES_TOKEN:-}" | tr -d '[:space:]')"
export SPRITES_TOKEN
auth=()
[ -n "$SPRITES_TOKEN" ] && auth=(-H "Authorization: Bearer $SPRITES_TOKEN")

log() { printf '\n==> %s\n' "$*"; }

# api METHOD PATH [curl args...]: prints the body; fails on an HTTP error.
api() {
  local method="$1" path="$2"
  shift 2
  curl -sS --fail-with-body -X "$method" "${auth[@]}" "$SPRITE$path" "$@"
}

urlencode() { jq -rn --arg v "$1" '$v | @uri'; }

# sprite_sh SCRIPT: runs SCRIPT with bash on the Sprite (POST /exec, script on stdin).
# The response body is framed: each output chunk starts with a stream byte (0x01 stdout,
# 0x02 stderr) and the body ends with 0x03 followed by the exit code as one byte. This prints
# the output without the framing and returns the remote exit code.
sprite_sh() {
  local raw code
  raw="$(mktemp)"
  api POST "/exec?cmd=bash&cmd=-s&stdin=true" -H "Content-Type: application/octet-stream" --data-binary "$1" >"$raw"
  code="$(perl -0777 -ne 'print /\x03(.)\z/s ? ord($1) : 0' "$raw")"
  perl -0777 -pe 's/\x03.\z//s; s/[\x01\x02]//g' "$raw"
  rm -f "$raw"
  return "$code"
}

task_check() {
  log "Sprite $SPRITE_NAME"
  api GET "" | jq '{name, status, url, url_settings, updated_at, last_started_at, last_active_at}'
  log "Services"
  api GET "/services" | jq -c '.' | head -c 4000
  echo
  log "Runtime on the Sprite"
  sprite_sh 'set +e
    echo "user: $(id -un), home: $HOME"
    uname -srm
    command -v node && node -v
    command -v npm && npm -v
    ls -la /home/sprite/last-orders 2>&1 | head -20
    if [ -e '"$AGENT_SECRET_FILE"' ]; then stat -c "secret file: %n mode %a size %s owner %U" '"$AGENT_SECRET_FILE"'; else echo "secret file: missing"; fi'
}

task_setup() {
  log "Node on the Sprite"
  sprite_sh 'set -e
    major() { node -v 2>/dev/null | sed -E "s/^v([0-9]+).*/\1/"; }
    if command -v node >/dev/null && [ "$(major)" -ge 22 ]; then
      echo "node $(node -v) already at $(command -v node)"; exit 0
    fi
    echo "installing Node 22 to $HOME/.local/node"
    arch=$(uname -m); case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac
    ver=$(curl -fsSL https://nodejs.org/dist/index.json | grep -o "\"version\":\"v22[^\"]*\"" | head -1 | cut -d\" -f4)
    mkdir -p "$HOME/.local/node"
    curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-linux-$arch.tar.xz" | tar -xJ -C "$HOME/.local/node" --strip-components=1
    "$HOME/.local/node/bin/node" -v
    echo "NODE_BIN=$HOME/.local/node/bin/node"'
}

task_connector_proof() {
  log "Connector proof from inside the Sprite (gateway $GATEWAY)"
  # The script runs on the Sprite. The gateway needs no auth header: it identifies the Sprite.
  sprite_sh 'set +e
GW='"$GATEWAY"'
body='"'"'{"model":"claude-sonnet-5-5","max_tokens":200,"messages":[{"role":"user","content":"Reply with one short sentence: you are the barman in a murder-mystery pub."}]}'"'"'
show() { # summarise a Messages response without dumping it
  python3 -c "import json,sys
raw=sys.stdin.read()
try: d=json.loads(raw)
except Exception: print(\"  non-JSON:\", raw[:400]); sys.exit()
if d.get(\"type\")==\"error\" or \"error\" in d: print(\"  error:\", json.dumps(d)[:600]); sys.exit()
txt=\" \".join(c.get(\"text\",\"\") for c in d.get(\"content\",[]) if c.get(\"type\")==\"text\")
print(\"  model:\", d.get(\"model\"), \"| stop:\", d.get(\"stop_reason\"), \"| usage:\", json.dumps(d.get(\"usage\")))
print(\"  text:\", txt[:300])" 2>/dev/null || cat
}
for v in 2023-06-01 2026-10-21; do
  echo "--- POST /v1/messages anthropic-version: $v"
  out=$(curl -sS -w "\nHTTP %{http_code} %{time_total}s" -X POST "$GW/v1/messages" \
    -H "content-type: application/json" -H "anthropic-version: $v" --data "$body")
  printf "%s\n" "$out" | tail -1
  printf "%s\n" "$out" | sed "\$d" | show
done
echo "--- GET /v1/models"
out=$(curl -sS -w "\nHTTP %{http_code}" "$GW/v1/models" -H "anthropic-version: 2023-06-01")
printf "%s\n" "$out" | tail -1
printf "%s\n" "$out" | sed "\$d" | python3 -c "import json,sys
raw=sys.stdin.read()
try: ids=[m[\"id\"] for m in json.loads(raw).get(\"data\",[])]
except Exception: print(\"  non-JSON:\", raw[:400]); sys.exit()
print(\"  ids:\", \", \".join(ids))
for want in (\"claude-sonnet-5-5\",\"claude-haiku-5-5\"): print(\"  listed\", want, want in ids)" 2>/dev/null || true
echo "--- @anthropic-ai/sdk with baseURL = gateway, dummy apiKey (sends x-api-key)"
export PATH="$HOME/.local/node/bin:$PATH"
d=/tmp/lo-sdk-proof; mkdir -p $d; cd $d
[ -f package.json ] || npm init -y >/dev/null 2>&1
[ -d node_modules/@anthropic-ai/sdk ] || npm i --silent @anthropic-ai/sdk >/dev/null 2>&1
npm ls @anthropic-ai/sdk 2>/dev/null | grep sdk
cat > proof.mjs <<EOF
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ baseURL: "$GW", apiKey: "dummy-not-a-key" });
try {
  const t = Date.now();
  const r = await client.messages.create({ model: "claude-sonnet-5-5", max_tokens: 60,
    messages: [{ role: "user", content: "Say: the bar is open." }] });
  console.log("  ok in", Date.now() - t, "ms | model:", r.model, "| usage:", JSON.stringify(r.usage));
  console.log("  text:", r.content.filter(c => c.type === "text").map(c => c.text).join(" ").slice(0, 200));
} catch (e) { console.log("  error:", e.status, String(e.message).slice(0, 400)); }
EOF
node proof.mjs'
}

task_secret() {
  command -v flyctl >/dev/null || { echo "ops: flyctl is required for the secret task" >&2; exit 1; }
  [ -n "${FLY_API_TOKEN:-}" ] || { echo "ops: FLY_API_TOKEN is not set" >&2; exit 1; }
  log "AGENT_SHARED_SECRET"
  local fly_has sprite_has
  fly_has="$(flyctl secrets list -a "$FLY_APP" --json | jq -r 'map(select((.Name // .name) == "AGENT_SHARED_SECRET")) | length')"
  sprite_has="$(sprite_sh "test -s '$AGENT_SECRET_FILE' && echo yes || echo no" | tr -dc 'a-z')"
  echo "Fly app has it: $fly_has; Sprite file present: $sprite_has"
  if [ "$fly_has" = "1" ] && [ "$sprite_has" = "yes" ] && [ "${FORCE_SECRET:-}" != "1" ]; then
    echo "Both exist; not regenerating (set FORCE_SECRET=1 to rotate)."
    return
  fi
  local secret
  secret="$(openssl rand -hex 32)"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::add-mask::$secret"
  # Staged: the running machine gets it on the next deploy (which reads staged secrets).
  printf 'AGENT_SHARED_SECRET=%s\n' "$secret" | flyctl secrets import --stage -a "$FLY_APP" >/dev/null
  echo "Staged on Fly app $FLY_APP"
  local dir
  dir="$(dirname "$AGENT_SECRET_FILE")"
  sprite_sh "mkdir -p '$dir' && chmod 700 '$dir'" >/dev/null
  printf '%s' "$secret" | api PUT "/fs/write?path=$(urlencode "$AGENT_SECRET_FILE")&workingDir=%2F&mode=0600&mkdir=true" \
    -H "Content-Type: application/octet-stream" --data-binary @- | jq -c '{path, size, mode}'
  unset secret
  log "Verify"
  flyctl secrets list -a "$FLY_APP" --json | jq -c 'map(select((.Name // .name) == "AGENT_SHARED_SECRET") | {name: (.Name // .name), digest: (.Digest // .digest), status: (.Status // .status)})'
  sprite_sh "stat -c '%n mode %a size %s owner %U' '$AGENT_SECRET_FILE'"
}

task_deploy_agent() {
  local node_bin
  node_bin="$(sprite_sh 'if [ -x "$HOME/.local/node/bin/node" ]; then echo "$HOME/.local/node/bin/node"; else command -v node; fi' | tail -1)"
  echo "NODE_BIN on the Sprite: $node_bin"
  NODE_BIN="$node_bin" bash "$(dirname "${BASH_SOURCE[0]}")/deploy-agent.sh"
}

task_public() {
  log "Setting url_settings.auth = public"
  api PUT "" -H "Content-Type: application/json" --data '{"url_settings":{"auth":"public"}}' | jq '{name, url, url_settings}'
}

# timing URL: one GET /healthz with curl's timing breakdown.
timing() {
  curl -sS -o /tmp/healthz.body -w 'HTTP %{http_code} connect %{time_connect}s tls %{time_appconnect}s ttfb %{time_starttransfer}s total %{time_total}s' "$1" || true
  echo "  body: $(head -c 200 /tmp/healthz.body 2>/dev/null)"
}

task_measure() {
  # GET /v1/sprites/{name} .status is not a wake signal: on 26 November 2026 it read "cold" while
  # the service answered in 0.2s with an unchanged pid. So this idles for IDLE_SECONDS with no
  # traffic to the Sprite URL (polling only the REST status, which does not wake it), then times
  # the first request and compares the service's pid and started_at before and after.
  local url idle="${IDLE_SECONDS:-900}" before after waited=0
  url="$(api GET "" | jq -r '.url')"
  log "Warm: GET $url/healthz x5"
  for _ in 1 2 3 4 5; do timing "$url/healthz"; sleep 1; done
  before="$(api GET "/services/$SERVICE_NAME" | jq -c '.state | {status, pid, started_at}')"
  echo "service before idle: $before"
  log "Idle ${idle}s with no requests to the Sprite URL (REST status every 60s)"
  while [ "$waited" -lt "$idle" ]; do
    sleep 60; waited=$((waited + 60))
    echo "  t=${waited}s sprite status=$(api GET "" | jq -r '.status')"
  done
  log "After ${idle}s idle: first GET $url/healthz"
  timing "$url/healthz"
  log "Then x3"
  for _ in 1 2 3; do timing "$url/healthz"; sleep 1; done
  after="$(api GET "/services/$SERVICE_NAME" | jq -c '.state | {status, pid, started_at}')"
  echo "service after idle: $after"
  [ "$before" = "$after" ] && echo "same process (no restart)" || echo "service state changed"
  log "POST /wake (no data)"
  curl -sS -X POST -w ' HTTP %{http_code} total %{time_total}s\n' "$url/wake" || true
}

case "${1:-}" in
  check) task_check ;;
  setup) task_setup ;;
  connector-proof) task_connector_proof ;;
  secret) task_secret ;;
  deploy-agent) task_deploy_agent ;;
  public) task_public ;;
  measure) task_measure ;;
  all) task_setup; task_secret; task_deploy_agent; task_public; task_check ;;
  *) sed -n '2,20p' "$0"; exit 2 ;;
esac
