#!/usr/bin/env bash
# Deploys the agent to the Sprite through the Sprites REST API (https://api.sprites.dev):
#   1. bundles apps/agent into one file, apps/agent/dist/agent.mjs (no node_modules needed);
#   2. uploads it to the Sprite and swaps it into place with a rename;
#   3. creates or updates the Sprite service that runs it, with the agent's environment;
#   4. restarts the service and fails if the process exits during the start window.
#
# STATUS: all steps verified against the live Sprites API on 26 November 2026 (Sprite ops run 45753317907). Endpoints follow
# https://api.sprites.dev/openapi.json as read on 25 November 2026.
#
# Auth: SPRITES_TOKEN is sent as a bearer token. When it is unset, no Authorization header is
# sent; that only works where a proxy injects one (the cloud agent sessions do).
#
# The Sprite must already exist, and the shared secret must already be in AGENT_SECRET_FILE on
# it. This script never writes the secret.
#
# Usage: bash infra/sprite/deploy-agent.sh        (from anywhere in the repo)
# Settings, all optional (defaults in brackets):
#   SPRITE_NAME         [last-orders-gm]
#   SERVICE_NAME        [last-orders-agent]
#   AGENT_DIR           [/home/sprite/last-orders]       where agent.mjs goes on the Sprite
#   AGENT_SECRET_FILE   [/home/sprite/.config/last-orders/agent-shared-secret]
#   AGENT_PORT          [8080]                           the wake server port, routed by the Sprite URL
#   NODE_BIN            [node]                           Node 22 or later on the Sprite
#   AGENT_APP_URL             [https://last-orders.fly.dev]           becomes APP_URL
#   AGENT_MODEL_ADAPTER       [anthropic]                             becomes MODEL_ADAPTER
#   AGENT_MODEL               [claude-sonnet-5-5]                     becomes MODEL
#   AGENT_ANTHROPIC_BASE_URL  [the Sprites gateway for connector      becomes ANTHROPIC_BASE_URL
#                              yscja5o0A-6UPqpa3IFdig]
# The agent's settings carry an AGENT_ prefix here so that an APP_URL, MODEL or
# ANTHROPIC_BASE_URL already in the caller's shell is never shipped to the Sprite by accident.
#   SKIP_BUNDLE=1       upload the existing apps/agent/dist/agent.mjs without rebuilding
set -euo pipefail

API="${SPRITES_API:-https://api.sprites.dev}"
SPRITE_NAME="${SPRITE_NAME:-last-orders-gm}"
SERVICE_NAME="${SERVICE_NAME:-last-orders-agent}"
AGENT_DIR="${AGENT_DIR:-/home/sprite/last-orders}"
AGENT_SECRET_FILE="${AGENT_SECRET_FILE:-/home/sprite/.config/last-orders/agent-shared-secret}"
AGENT_PORT="${AGENT_PORT:-8080}"
NODE_BIN="${NODE_BIN:-node}"
AGENT_APP_URL="${AGENT_APP_URL:-https://last-orders.fly.dev}"
AGENT_MODEL_ADAPTER="${AGENT_MODEL_ADAPTER:-anthropic}"
AGENT_MODEL="${AGENT_MODEL:-claude-sonnet-5-5}"
AGENT_ANTHROPIC_BASE_URL="${AGENT_ANTHROPIC_BASE_URL:-https://api.sprites.dev/v1/gateway/anthropic/yscja5o0A-6UPqpa3IFdig}"

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
BUNDLE="$ROOT/apps/agent/dist/agent.mjs"
SPRITE_URL="$API/v1/sprites/$SPRITE_NAME"

for tool in curl jq; do
  command -v "$tool" >/dev/null || { echo "deploy-agent: $tool is required" >&2; exit 1; }
done

auth=()
# Strip all whitespace from the token. A trailing newline (easy to paste into a GitHub secret)
# ends the HTTP header block early: curl sends "Bearer <token>\n\r\n", the server sees an empty
# line, and every header after Authorization becomes the start of the request body. The upload
# then silently gains those header bytes and JSON calls fail with "invalid character 'C'".
SPRITES_TOKEN="$(printf '%s' "${SPRITES_TOKEN:-}" | tr -d '[:space:]')"
if [ -n "$SPRITES_TOKEN" ]; then
  auth=(-H "Authorization: Bearer $SPRITES_TOKEN")
else
  echo "deploy-agent: SPRITES_TOKEN is not set; sending no Authorization header" >&2
fi

# api METHOD PATH [curl args...]: prints the response body; exits on an HTTP error.
api() {
  local method="$1" path="$2"
  shift 2
  curl -sS --fail-with-body -X "$method" "${auth[@]}" "$SPRITE_URL$path" "$@"
}

if [ "${SKIP_BUNDLE:-}" != "1" ]; then
  echo "==> Bundling the agent"
  npm --prefix "$ROOT" run bundle -w @last-orders/agent
fi
[ -s "$BUNDLE" ] || { echo "deploy-agent: $BUNDLE is missing" >&2; exit 1; }

echo "==> Checking Sprite $SPRITE_NAME"
api GET "" | jq -r '"status: \(.status), url: \(.url)"'

# Query-string encoding for the fs endpoints.
urlencode() { jq -rn --arg v "$1" '$v | @uri'; }

bundle_size="$(wc -c <"$BUNDLE" | tr -d ' ')"
echo "==> Uploading $bundle_size bytes to $AGENT_DIR/agent.mjs"
written="$(api PUT "/fs/write?path=$(urlencode "$AGENT_DIR/agent.mjs.new")&workingDir=%2F&mode=0644&mkdir=true" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@$BUNDLE")"
printf '%s\n' "$written" | jq -c .
written_size="$(printf '%s' "$written" | jq -r '.size')"
if [ "$written_size" != "$bundle_size" ]; then
  echo "deploy-agent: the Sprite wrote $written_size bytes, expected $bundle_size" >&2
  exit 1
fi
# Swap in the new file in one step, so a restart never sees a half-written bundle.
api POST "/fs/rename" -H "Content-Type: application/json" \
  --data "$(jq -n --arg s "$AGENT_DIR/agent.mjs.new" --arg d "$AGENT_DIR/agent.mjs" \
    '{source: $s, dest: $d, workingDir: "/", asRoot: false}')" | jq -c .

echo "==> Defining service $SERVICE_NAME"
service="$(jq -n \
  --arg node "$NODE_BIN" \
  --arg bundle "$AGENT_DIR/agent.mjs" \
  --arg dir "$AGENT_DIR" \
  --argjson port "$AGENT_PORT" \
  --arg app_url "$AGENT_APP_URL" \
  --arg secret_file "$AGENT_SECRET_FILE" \
  --arg adapter "$AGENT_MODEL_ADAPTER" \
  --arg model "$AGENT_MODEL" \
  --arg base_url "$AGENT_ANTHROPIC_BASE_URL" \
  '{
    cmd: $node,
    args: [$bundle],
    dir: $dir,
    needs: [],
    http_port: $port,
    env: {
      NODE_ENV: "production",
      PORT: ($port | tostring),
      APP_URL: $app_url,
      AGENT_SHARED_SECRET_FILE: $secret_file,
      MODEL_ADAPTER: $adapter,
      MODEL: $model,
      ANTHROPIC_BASE_URL: $base_url
    }
  }')"
# The response is NDJSON progress events (measured 26 November 2026), not the service object.
api PUT "/services/$SERVICE_NAME" -H "Content-Type: application/json" --data "$service" | jq -c . | tail -5
api GET "/services/$SERVICE_NAME" | jq -c '{name, cmd, args, http_port, state}'

echo "==> Restarting $SERVICE_NAME"
# The response is NDJSON progress for the stop and the start, then a watch of the first seconds
# of output. An exit or error event after the start means the agent did not stay up.
events="$(api POST "/services/$SERVICE_NAME/restart")"
printf '%s\n' "$events" | jq -r 'select(.type == "stdout" or .type == "stderr") | "  [\(.type)] \(.data)"'
failure="$(printf '%s\n' "$events" | jq -rs '
  (map(.type) | index("started")) as $start
  | [ .[($start // 0):][] | select(.type == "error" or .type == "exit") ]
  | first // empty | tojson')"
if [ -n "$failure" ]; then
  echo "deploy-agent: the service did not stay up: $failure" >&2
  exit 1
fi

echo "==> Sprite URL"
# The Sprite URL routes to the service's http_port. The app needs url_settings.auth = public to
# reach POST /wake (see ops.sh public). AGENT_WAKE_URL in fly.toml is <url>/wake.
api GET "" | jq -r '"url: \(.url), url auth: \(.url_settings.auth // "unknown")"'
