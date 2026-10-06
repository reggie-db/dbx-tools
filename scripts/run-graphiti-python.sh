#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DATA_DIR="${GRAPHITI_DATA_DIR:-$ROOT/.home/graphiti-python}"
MODEL_NAME="${MODEL_NAME:-${1:-databricks-gpt-5-nano}}"
FALKORDB_HOST="${FALKORDB_HOST:-127.0.0.1}"
FALKORDB_PORT="${FALKORDB_PORT:-6379}"
UVICORN_HOST="${UVICORN_HOST:-127.0.0.1}"
UVICORN_PORT="${UVICORN_PORT:-7272}"

command -v nc >/dev/null 2>&1 || {
  printf 'nc is required to wait for FalkorDB readiness\n' >&2
  exit 1
}

mkdir -p "$DATA_DIR"

bun "$ROOT/packages/js/cli/falkor-db/bin/dbx-falkor-db.ts" \
  --data-dir "$DATA_DIR/falkordb" \
  --listen "tcp://$FALKORDB_HOST:$FALKORDB_PORT" &
FALKORDB_PID=$!
APP_PID=""

cleanup() {
  if [[ -n "$APP_PID" ]]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  kill "$FALKORDB_PID" 2>/dev/null || true
  wait "$FALKORDB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in {1..100}; do
  nc -z "$FALKORDB_HOST" "$FALKORDB_PORT" && break
  kill -0 "$FALKORDB_PID" 2>/dev/null || {
    printf 'FalkorDB exited before listening on %s:%s\n' "$FALKORDB_HOST" "$FALKORDB_PORT" >&2
    exit 1
  }
  sleep 0.1
done
nc -z "$FALKORDB_HOST" "$FALKORDB_PORT" || {
  printf 'Timed out waiting for %s:%s\n' "$FALKORDB_HOST" "$FALKORDB_PORT" >&2
  exit 1
}

export DB_BACKEND=falkordb
export FALKORDB_DATABASE="${FALKORDB_DATABASE:-default_db}"
export FALKORDB_HOST
export FALKORDB_PORT
export FALKORDB_URI="redis://$FALKORDB_HOST:$FALKORDB_PORT"
export FALKORDB_LISTEN="tcp://$FALKORDB_HOST:$FALKORDB_PORT"
export UVICORN_HOST
export UVICORN_PORT
export GRAPHITI_LISTEN="tcp://$UVICORN_HOST:$UVICORN_PORT"
export MODEL_NAME
export TEMPERATURE="${TEMPERATURE:-1}"

uv run uvicorn dbx_tools.graphiti.main:app &
APP_PID=$!
wait "$APP_PID"
