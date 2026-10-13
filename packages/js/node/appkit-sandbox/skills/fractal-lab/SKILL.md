---
name: fractal-lab
description: Create a self-contained interactive Mandelbrot and Julia-set browser demo served from an assigned Databricks Sandbox.
---

# Fractal Lab

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
`name: "fractal-lab"`, and this mise configuration as the `config` object:

```toml
[tools]
python = "3.12.12"

[tasks.start]
run = '''
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *python*http.server*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
nohup setsid python -m http.server "$PROJECT_PORT" --bind 127.0.0.1 > server.log 2>&1 < /dev/null &
echo $! > server.pid
'''

[tasks.stop]
run = '''
"$HOME/.local/bin/mise" run uninstall
'''
```

The `start` task starts a loopback static server in the project directory and is
a no-op while that server is running.

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
        *python*http.server*) owned=true ;;
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
rm -f server.pid
```

Uninstall validates the PID's command and working directory before terminating
the isolated process group. It always removes malformed, dead, mismatched, or
completed PID files, so repeated removal is safe.

## Application

Write `index.html` in the returned `directory`. Use one local HTML document
with CSS, JavaScript, canvas, and an inline Web Worker. Include Mandelbrot and
Julia modes, pointer-centered zoom, pan, reset, iteration and palette controls,
coordinates, render duration, and presets. Reduce work during interaction and
refine after input settles. Do not use external CDNs, fonts, packages, or
root-absolute URLs.

After writing `index.html`, list the project tasks and confirm `start` is
present. From the returned `directory`, call `execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]`. To stop the server,
use the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`; `stop` delegates to
`uninstall`. Project removal invokes `uninstall` automatically and never
invokes `stop`.

Return the project's `openUrl`.
