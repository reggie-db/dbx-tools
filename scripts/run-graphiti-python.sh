#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
GRAPHITI_HOME="${GRAPHITI_HOME:-$ROOT/.home/graphiti-python}"
MODEL_NAME="${MODEL_NAME:-${1:-databricks-gpt-5-nano}}"
UVICORN_HOST="${UVICORN_HOST:-127.0.0.1}"
UVICORN_PORT="${UVICORN_PORT:-7272}"

mkdir -p "$GRAPHITI_HOME"

export GRAPHITI_HOME
export UVICORN_HOST
export UVICORN_PORT
export GRAPHITI_LISTEN="tcp://$UVICORN_HOST:$UVICORN_PORT"
export MODEL_NAME
export TEMPERATURE="${TEMPERATURE:-1}"

exec uv run uvicorn dbx_tools.graphiti.main:app
