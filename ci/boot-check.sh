#!/usr/bin/env bash
# Boots the built API bundle, waits for GET /healthz to answer 200, then holds a few seconds and
# checks again, so a bundle that dies on start or just after listening fails CI. Run after
# `pnpm --filter '@sky/api...' build`. Every secret below is a dummy.
#
# The bundle runs from a runtime tree laid out as the Dockerfile's is (bundle, migrations beside it,
# a package.json above it, better-sqlite3 in node_modules), because that package.json makes Node load
# the bundle as ESM, bundled code reads migrations at `../drizzle`, and the bundle's one external
# resolves from `node_modules` there.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${BOOT_CHECK_PORT:-18080}"
BOOT_SECONDS=30
# time for a rejection in boot's unawaited background work (sweeps, dispatcher) to kill the process
HOLD_SECONDS=3
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

healthz_code() {
  curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$PORT/healthz" || true
}

fail_with_log() {
  echo "boot check failed: $1" >&2
  cat "$LOG" >&2
  exit 1
}

# the guard keeps a non-zero status from tripping errexit; clearing PID keeps cleanup from waiting again
fail_exited() {
  local status=0
  wait "$PID" || status=$?
  PID=""
  fail_with_log "the bundle exited with status $status $1"
}

mkdir "$WORK/app" "$WORK/data"
cp -R apps/api/dist/bundle apps/api/dist/drizzle "$WORK/app/"
echo '{"private":true,"type":"module"}' > "$WORK/app/package.json"
mkdir "$WORK/app/node_modules"
# the copy pnpm already built; the image installs the same version with npm
ln -s "$(realpath apps/api/node_modules/better-sqlite3)" "$WORK/app/node_modules/better-sqlite3"

# the image's ENV (Dockerfile); bundled libraries read it at runtime
export NODE_ENV=production
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

deadline=$((SECONDS + BOOT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  kill -0 "$PID" 2>/dev/null || fail_exited "before /healthz answered"
  if [ "$(healthz_code)" = "200" ]; then
    sleep "$HOLD_SECONDS"
    kill -0 "$PID" 2>/dev/null || fail_exited "within ${HOLD_SECONDS}s of /healthz first answering 200"
    [ "$(healthz_code)" = "200" ] ||
      fail_with_log "/healthz stopped answering 200 within ${HOLD_SECONDS}s of first answering it"
    echo "boot check passed: /healthz answered 200, and again ${HOLD_SECONDS}s later"
    exit 0
  fi
  sleep 1
done

fail_with_log "/healthz did not answer 200 within ${BOOT_SECONDS}s"
