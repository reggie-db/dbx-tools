---
name: realtime-whiteboard
description: Run the WBO collaborative whiteboard in an assigned Databricks Sandbox to demonstrate owner-scoped WebSocket routing.
---

# Realtime Whiteboard

Call `list_ssh_machines` first and reuse a matching project when present. Call
`add_ssh_project` with the returned `machineId`,
`name: "realtime-whiteboard"`, `tools: { "node": "24" }`,
`env: { "WBO_VERSION": "2.17.1", "WBO_HISTORY_DIR": "{{config_root}}/boards" }`,
and the lifecycle scripts below.

Install script:

```sh
set -eu
rm -rf app
mkdir -p app "$WBO_HISTORY_DIR"
curl -fsSL "https://github.com/lovasoa/whitebophir/archive/refs/tags/v$WBO_VERSION.tar.gz" \
  | tar -xz --strip-components=1 -C app
(cd app && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
```

Start script:

```sh
set -eu
if [ -f server.pid ]; then kill "$(cat server.pid)" 2>/dev/null || true; fi
(
  cd app
  HOST=127.0.0.1 PORT="$PROJECT_PORT" \
    nohup node server/server.mjs > ../server.log 2>&1 < /dev/null &
  echo $! > ../server.pid
)
```

Boards persist in the project directory. Keep the server loopback-only and use
the returned owner-scoped AppKit route. WebSocket clients must use relative URLs
so the route prefix remains intact. The runtime restarts the workload after a
machine boot and owns PID teardown. Return the project's `openUrl` as a Markdown
link.
