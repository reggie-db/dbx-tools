---
name: realtime-whiteboard
description: Build a collaborative browser whiteboard that demonstrates owner-scoped WebSocket routing through an assigned Databricks Sandbox.
---

# Realtime Whiteboard

Project workflow is required. Explicit runtime tasks come from the project's
mise config, while its first-class `uninstall` owns automatic removal.
Do not install packages, write launch scripts, or start
servers with ad-hoc commands. Use
`execute_ssh_command` to write the application files below and to invoke the
documented mise task, with `cwd` set to the returned `directory`. Before
running a task, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the result; use `start` to launch the server and `stop` to stop it.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write demo files under
`~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox URL, or add a
second password or token. All setup and tasks run as the fixed, unprivileged
`sandbox-user`.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "realtime-whiteboard"`, and this mise configuration as the `config`
object:

```toml
[tools]
bun = "1.4.2"

[tasks.start]
run = '''
[ -f server.ts ] || exit 0
stamp="$(cat server.ts index.html 2>/dev/null | cksum)"
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *bun*server.ts*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ] && \
            [ "$stamp" = "$(cat server.stamp 2>/dev/null)" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
nohup setsid bun server.ts > server.log 2>&1 < /dev/null &
echo $! > server.pid
printf '%s\n' "$stamp" > server.stamp
'''

[tasks.stop]
run = '''
"$HOME/.local/bin/mise" run uninstall
'''
```

The `start` task waits for `server.ts`, starts it, and restarts it only when the
server or page changes.

Pass the following script as the first-class `uninstall` option:

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
        *bun*server.ts*) owned=true ;;
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
completed PID and stamp files, so repeated removal is safe.

## Application

Write `index.html` and `server.ts` in the returned `directory`. Build one
self-contained page with pointer and touch drawing, color and stroke controls,
undo, clear, connection state, and participant count. Use Bun's HTTP and
WebSocket APIs. Keep bounded in-memory history, validate message shapes, cap
message sizes, and broadcast drawing operations instead of screenshots.

`server.ts` binds to loopback at `127.0.0.1` on
`Number(process.env.PROJECT_PORT)`. The browser must derive `ws://` or `wss://`
from the current public origin and connect below the returned project path.
Use relative HTTP URLs.

After writing or changing the files, list the project tasks and confirm
`start` is present. From the returned `directory`, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]` so the task starts or
restarts the server. To stop the server, use the same command and directory
with `args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`; `stop` delegates
to `uninstall`. Project removal invokes `uninstall` automatically and never
invokes `stop`. Return the project's `openUrl`.

AppKit forwards standard HTTP Upgrade requests and strips the project path when
`stripPrefix` is true. Raw TCP, UDP, fixed-root socket URLs, and a second
unregistered port are not supported.
