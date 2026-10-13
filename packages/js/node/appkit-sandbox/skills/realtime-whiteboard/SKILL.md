---
name: realtime-whiteboard
description: Run the WBO collaborative whiteboard in an assigned Databricks Sandbox to demonstrate owner-scoped WebSocket routing.
---

# Realtime Whiteboard

Project workflow is required. Put WBO installation and the initial server
launch in `hooks.postinstall` so `add_ssh_project` reports setup progress and
returns only after the whiteboard is ready. Do not define `start`, `stop`, or
hidden tasks. The first-class `uninstall` owns automatic removal.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write project files under `~/.dbx-tools/runtime`, invent a route,
publish a direct Sandbox URL, or add a second password or token. All setup and
tasks run as the fixed, unprivileged `sandbox-user`.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "realtime-whiteboard"`, and the complete TOML below as `config`:

```toml
[tools]
node = "24"

[env]
WBO_VERSION = "2.17.1"
WBO_HISTORY_DIR = "{{config_root}}/boards"

[hooks]
postinstall = '''
set -eu
marker="app/.installed-$WBO_VERSION"
if [ ! -f "$marker" ]; then
  rm -rf app
  mkdir -p app
  curl -fsSL "https://github.com/lovasoa/whitebophir/archive/refs/tags/v$WBO_VERSION.tar.gz" \
    | tar -xz --strip-components=1 -C app
  (cd app && npm install --omit=dev --ignore-scripts --no-audit --no-fund) > setup.log 2>&1
  touch "$marker"
fi
mkdir -p "$WBO_HISTORY_DIR"
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *node*server/server.mjs*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD/app" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
(
  cd app
  HOST=127.0.0.1 PORT="$PROJECT_PORT" \
    nohup setsid node server/server.mjs > ../server.log 2>&1 < /dev/null &
  echo $! > ../server.pid
)
for _ in $(seq 1 50); do
  if bash -c 'exec 3<>/dev/tcp/127.0.0.1/'"$PROJECT_PORT" 2>/dev/null; then
    exit 0
  fi
  sleep 0.2
done
cat server.log >&2
exit 1
'''
```

The install hook downloads the pinned WBO release once, installs its
production dependencies, launches it on loopback, and waits until it accepts
connections. Boards persist in the project's `boards` directory. Pass the
following script as the first-class `uninstall` option:

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
        *node*server/server.mjs*) owned=true ;;
        *) owned=false ;;
      esac
      if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD/app" ] && [ "$owned" = true ]; then
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
rm -f server.pid
```

Uninstall validates the PID's command and working directory before terminating
the isolated process group, so repeated removal is safe. Installation failures
fail `add_ssh_project`; inspect `setup.log` and `server.log` in the project
directory with `execute_ssh_command` for diagnostics only. Project removal
invokes `uninstall` automatically. Return the project's `openUrl` as a Markdown link.
