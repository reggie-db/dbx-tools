---
name: network-speed-test
description: Run LibreSpeed in an assigned Databricks Sandbox to measure browser-to-AppKit-to-Sandbox HTTP throughput.
---

# Network Speed Test

Call `list_ssh_machines` first and reuse a matching project when present. Call
`add_ssh_project` with the returned `machineId`, `name: "speed-test"`,
`tools: { "github:librespeed/speedtest-go": "1.1.6" }`, and the lifecycle
scripts below.

Install script:

```sh
set -eu
cat > settings.toml <<EOF
bind_address = "127.0.0.1"
listen_port = ${PROJECT_PORT}
server_lat = 1
server_lng = 1
database_type = "none"
EOF
```

Start script:

```sh
set -eu
if [ -f server.pid ]; then kill "$(cat server.pid)" 2>/dev/null || true; fi
nohup "$HOME/.local/bin/mise" --no-hooks exec -- speedtest-backend > server.log 2>&1 < /dev/null &
echo $! > server.pid
```

Do not call public speed-test services or external CDNs. The result measures
browser-to-AppKit-to-Sandbox traffic, including proxy and SSH forwarding
overhead; it is not an ISP or raw workspace network test. Keep the server
loopback-only. The runtime restarts the workload after a machine boot and owns
PID teardown. Return the project's `openUrl` as a Markdown link.
