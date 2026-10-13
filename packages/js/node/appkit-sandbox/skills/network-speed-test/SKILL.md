---
name: network-speed-test
description: Run LibreSpeed in an assigned Databricks Sandbox to measure browser-to-AppKit-to-Sandbox HTTP throughput.
---

# Network Speed Test

Project workflow is required. Put LibreSpeed launch in `hooks.postinstall` so
`add_ssh_project` reports setup progress and returns only after the server is
ready. Do not define `start`, `stop`, or hidden tasks. The first-class
`uninstall` owns automatic removal.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write demo files under
`~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox URL, or add a
second password or token. All setup and tasks run as the fixed, unprivileged
`sandbox-user`. Do not call public speed-test services or external CDNs.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "speed-test"`, and the complete TOML below as `config`:

```toml
[tools]
"github:librespeed/speedtest-go" = "1.1.6"

[hooks]
postinstall = '''
set -eu
cat > settings.toml <<EOF
bind_address = "127.0.0.1"
listen_port = ${PROJECT_PORT}
server_lat = 1
server_lng = 1
database_type = "none"
EOF
stamp="$(cksum < settings.toml)"
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *speedtest*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ] && \
            [ "$stamp" = "$(cat server.stamp 2>/dev/null)" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
nohup setsid "$HOME/.local/bin/mise" --no-hooks exec -- speedtest-backend > server.log 2>&1 < /dev/null &
echo $! > server.pid
printf '%s\n' "$stamp" > server.stamp
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if bash -c 'exec 3<>/dev/tcp/127.0.0.1/'"$PROJECT_PORT" 2>/dev/null; then
    exit 0
  fi
  sleep 0.2
done
cat server.log >&2
exit 1
'''
```

mise installs LibreSpeed from GitHub releases. The postinstall hook writes
loopback `settings.toml`, starts the binary, and waits until it accepts
connections. Pass the following script as the first-class `uninstall` option:

```sh
set -eu
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *speedtest*) owned=true ;;
        *) owned=false ;;
      esac
      if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ] && [ "$owned" = true ]; then
        pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
        if [ "$pgid" = "$pid" ]; then
          kill -TERM -- "-$pid" 2>/dev/null || true
        else
          pkill -P "$pid" 2>/dev/null || true
          kill -TERM "$pid" 2>/dev/null || true
        fi
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          if [ "$pgid" = "$pid" ]; then
            pgrep -g "$pid" >/dev/null 2>&1 || break
          else
            kill -0 "$pid" 2>/dev/null || break
          fi
          sleep 0.2
        done
        if [ "$pgid" = "$pid" ]; then
          if pgrep -g "$pid" >/dev/null 2>&1; then
            kill -KILL -- "-$pid" 2>/dev/null || true
          fi
        elif kill -0 "$pid" 2>/dev/null; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
      ;;
  esac
fi
rm -f server.pid server.stamp
```

Uninstall validates the PID's command and working directory before terminating
the isolated process group. It always removes malformed, dead, mismatched, or
completed PID and stamp files, so repeated removal is safe. Project removal
invokes `uninstall` automatically. Return the project's `openUrl` as a Markdown link.

Label the result as browser-to-AppKit-to-Sandbox performance, including proxy
and SSH forwarding overhead. It is not an ISP or raw workspace network test.
