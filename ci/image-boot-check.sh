#!/usr/bin/env bash
# Runs an already built image of the repo's Dockerfile detached, waits for GET /healthz to answer 200, then holds a few seconds and checks again, so an
# image that dies on start or just after listening fails CI. This covers what the bundle boot check
# (ci/boot-check.sh) cannot: the ENTRYPOINT that creates $DATA_DIR and drops to uid node, NODE_ENV and
# DATA_DIR from the image's ENV, the image's own npm install of better-sqlite3 and the copied
# migrations. Every secret below is a dummy. Needs Docker; nothing is pushed.
#
#   docker build -t sky-api:boot-check . && ci/image-boot-check.sh [image-tag]
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE="${1:-sky-api:boot-check}"
HOST_PORT="${BOOT_CHECK_PORT:-18081}"
# the port the image's app listens on (config default, Dockerfile EXPOSE)
APP_PORT=8080
BOOT_SECONDS=60
# time for a rejection in boot's unawaited background work (sweeps, dispatcher) to kill the process
HOLD_SECONDS=5
NAME="sky-boot-check-$$"
STARTED=""

cleanup() {
  if [ -n "$STARTED" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

healthz_code() {
  curl -s --connect-timeout 1 --max-time 2 -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:$HOST_PORT/healthz" || true
}

running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" = "true" ]
}

fail_with_log() {
  echo "image boot check failed: $1" >&2
  docker logs "$NAME" >&2 || true
  exit 1
}

# DATA_DIR and NODE_ENV come from the image's ENV, as in production; the dummy secrets match boot-check.sh
docker run -d --name "$NAME" -p "127.0.0.1:$HOST_PORT:$APP_PORT" \
  -e SKY_API_KEY="boot-check-api-key-boot-check-api-key" \
  -e SPRITES_TOKEN="boot-check" \
  -e CLAUDE_CODE_OAUTH_TOKEN="boot-check" \
  -e PUBLIC_BASE_URL="http://127.0.0.1:$HOST_PORT" \
  -e WEBHOOK_SIGNING_KEY="boot-check-webhook-key-boot-check-webhook" \
  -e SECRET_ENCRYPTION_KEY="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
  "$IMAGE" >/dev/null
STARTED=1

deadline=$((SECONDS + BOOT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
  running || fail_with_log "the container exited before /healthz answered"
  if [ "$(healthz_code)" = "200" ]; then
    sleep "$HOLD_SECONDS"
    running || fail_with_log "the container exited within ${HOLD_SECONDS}s of /healthz first answering 200"
    [ "$(healthz_code)" = "200" ] ||
      fail_with_log "/healthz stopped answering 200 within ${HOLD_SECONDS}s of first answering it"
    echo "image boot check passed: /healthz answered 200, and again ${HOLD_SECONDS}s later"
    exit 0
  fi
  sleep 1
done

fail_with_log "/healthz did not answer 200 within ${BOOT_SECONDS}s"
