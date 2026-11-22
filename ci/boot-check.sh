#!/usr/bin/env bash
# Boots the built API bundle and waits for GET /healthz to answer 200, so a bundle that dies on
# start fails CI. Run after `pnpm --filter '@sky/api...' build`. Every value below is a dummy.
#
# The bundle runs from a runtime tree laid out as the Dockerfile's is (bundle, migrations beside it,
# a package.json above it, better-sqlite3 in node_modules), because bundled code reads
# `../package.json` and the bundle's one external from there.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${BOOT_CHECK_PORT:-18080}"
WORK="$(mktemp -d)"
LOG="$WORK/boot.log"
PID=""
cleanup() {
  if [ -n "$PID" ]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir "$WORK/app" "$WORK/data"
cp -R apps/api/dist/bundle apps/api/dist/drizzle "$WORK/app/"
echo '{"private":true,"type":"module"}' > "$WORK/app/package.json"
mkdir "$WORK/app/node_modules"
# the copy pnpm already built; the image installs the same version with npm
ln -s "$(realpath apps/api/node_modules/better-sqlite3)" "$WORK/app/node_modules/better-sqlite3"

export DATA_DIR="$WORK/data" PORT
export SKY_API_KEY="boot-check-api-key-boot-check-api-key"
export SPRITES_TOKEN="boot-check"
export CLAUDE_CODE_OAUTH_TOKEN="boot-check"
export PUBLIC_BASE_URL="http://127.0.0.1:$PORT"
export WEBHOOK_SIGNING_KEY="boot-check-webhook-key-boot-check-webhook"
# 32 zero bytes, base64
export SECRET_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

node "$WORK/app/bundle/main.js" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 30); do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "boot check failed: the bundle exited before /healthz answered" >&2
    cat "$LOG" >&2
    exit 1
  fi
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" || true)" = "200" ]; then
    echo "boot check passed: /healthz answered 200"
    exit 0
  fi
  sleep 1
done

echo "boot check failed: /healthz did not answer 200 within 30s" >&2
cat "$LOG" >&2
exit 1
