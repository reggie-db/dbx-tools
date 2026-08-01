#!/usr/bin/env bash
# Databricks Apps boot wrapper for the dbx-tools demo.
#
# Supervises the bun server entrypoint (`bun src/server.ts`) and, when
# PUBLIC_DOMAIN is set, publishes the app to a public URL through portr
# (https://portr.dev) alongside it. The public tunnel bypasses the Databricks
# Apps OAuth front door - so the app gates ITSELF with the email-OTP access gate
# (the `@dbx-tools/email` plugin's `auth`, whitelisted to the Databricks domain).
#
# Public tunnel (opt-in): set both in the app env (resources/app.yml / app.yaml):
#   PUBLIC_DOMAIN=<subdomain>.<portr-server>   e.g. demo.apps.dbx.tools
#   PORTR_TOKEN=<portr secret_key>             usually `valueFrom:` a secret
# The leftmost dotted label of PUBLIC_DOMAIN is the portr subdomain; the rest is
# the portr server host. Unset PUBLIC_DOMAIN (or empty PORTR_TOKEN) -> no tunnel,
# just bun.
#
# Adapted from the taco-bell-genie-demo start.sh: same supervise + graceful
# shutdown, but the foreground role is `bun`, not node.
set -euo pipefail

readonly SHUTDOWN_GRACE_SECS=5

# Run in development so the genie/mastra plugins fall back to the app service
# principal when a request carries no user token - which is exactly the case for
# a request arriving through the public portr tunnel (it bypasses the Apps front
# door that injects the user token). server.ts pins an explicit staticPath, so
# dev mode still serves the prebuilt client bundle rather than a Vite dev server.
export NODE_ENV="${NODE_ENV:-development}"

# When a public tunnel is enabled we front the app with the email-OTP gate proxy:
# the proxy binds DATABRICKS_APP_PORT (what portr tunnels) and the app binds a
# loopback APP_INTERNAL_PORT that only the proxy reaches. Without a tunnel the app
# binds DATABRICKS_APP_PORT directly (no proxy, no gate). The proxy is required
# because AppKit's in-app gate can't cover sibling plugin APIs (see gate-proxy.ts).
_gate_enabled=0
if [[ -n "${PUBLIC_DOMAIN:-}" && -n "${PORTR_TOKEN:-}" ]]; then
  _gate_enabled=1
  export APP_INTERNAL_PORT="${APP_INTERNAL_PORT:-8001}"
fi

declare -A _pids=()
_bun_pid=""
_proxy_pid=""
_portr_pid=""
_shutdown=0

_register() { _pids["$1"]="$2"; }

# Optional public tunnel.
if [[ -n "${PUBLIC_DOMAIN:-}" ]]; then
  if [[ -z "${PORTR_TOKEN:-}" ]]; then
    echo "[start] PUBLIC_DOMAIN=${PUBLIC_DOMAIN} set but PORTR_TOKEN empty - skipping tunnel" >&2
  else
    _portr_subdomain="${PUBLIC_DOMAIN%%.*}"
    _portr_server="${PUBLIC_DOMAIN#*.}"
    if [[ "$_portr_subdomain" == "$PUBLIC_DOMAIN" || -z "$_portr_server" ]]; then
      echo "[start] PUBLIC_DOMAIN must include a subdomain (e.g. demo.apps.dbx.tools) - skipping tunnel" >&2
    else
      # Re-root HOME under cwd: the platform $HOME is read-only on cold start, so
      # the portr installer + config need a writable, per-app location.
      export HOME="${PWD}/.home"
      mkdir -p "${HOME}/.portr/bin"
      export PORTR_AUTO_ADD_PATH=no
      export PATH="${HOME}/.portr/bin:${PATH}"

      curl -sSf https://install.portr.dev | sh

      cat > "${HOME}/.portr/config.yaml" <<EOF
server_url: ${_portr_server}
ssh_url: ${_portr_server}:4444
secret_key: ${PORTR_TOKEN}
disable_dashboard: true
disable_tui: true
tunnels:
  - name: ${_portr_subdomain}
    subdomain: ${_portr_subdomain}
    port: ${DATABRICKS_APP_PORT}
EOF

      pkill -x portr 2>/dev/null || true
      portr start &
      _portr_pid=$!
      _register portr "$_portr_pid"
      echo "[start] portr tunneling https://${PUBLIC_DOMAIN} -> :${DATABRICKS_APP_PORT} (pid=${_portr_pid})" >&2
    fi
  fi
fi

# ─── Graceful shutdown ──────────────────────────────────────────────────
_any_alive() {
  local pid
  for pid in "${_pids[@]}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then return 0; fi
  done
  return 1
}

_signal_each() {
  local sig=$1 name pid
  for name in "${!_pids[@]}"; do
    pid="${_pids[$name]}"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[start] sending SIG${sig} to ${name} (pid=${pid})" >&2
      kill -"$sig" "$pid" 2>/dev/null || true
    fi
  done
}

_terminate_all() {
  if (( _shutdown )); then return; fi
  _shutdown=1
  _signal_each TERM
  (
    for _ in $(seq 1 "$SHUTDOWN_GRACE_SECS"); do
      sleep 1
      _any_alive || exit 0
    done
    echo "[start] grace window elapsed, sending SIGKILL to survivors" >&2
    _signal_each KILL
  ) &
}

_signal_handler() {
  echo "[start] caught $1, shutting down" >&2
  _terminate_all
}
trap '_signal_handler TERM' TERM
trap '_signal_handler INT'  INT
trap '_signal_handler HUP'  HUP

# The email-OTP gate proxy (only when a tunnel is enabled): binds the public
# DATABRICKS_APP_PORT and forwards authenticated traffic to the app on
# APP_INTERNAL_PORT. Started before the app so it's listening when portr connects;
# it simply 502s until the app is up, then serves gated.
if (( _gate_enabled )); then
  bun scripts/gate-proxy.ts &
  _proxy_pid=$!
  _register gate-proxy "$_proxy_pid"
  echo "[start] gate proxy on :${DATABRICKS_APP_PORT} -> app :${APP_INTERNAL_PORT}" >&2
fi

# The app. Foreground role the Apps platform health-checks against (when no
# proxy, it binds DATABRICKS_APP_PORT directly). Run bun directly so this shell
# supervises it and forwards signals.
bun src/server.ts &
_bun_pid=$!
_register bun "$_bun_pid"

_exit_code=0
while kill -0 "$_bun_pid" 2>/dev/null; do
  if wait "$_bun_pid" 2>/dev/null; then _exit_code=0; else _exit_code=$?; fi
done

_terminate_all
wait 2>/dev/null || true
exit "$_exit_code"
