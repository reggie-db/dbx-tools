---
name: jupyter-lab
description: Run JupyterLab through an authenticated Sandbox project without a separate Jupyter password or token.
---

# JupyterLab

Project workflow is required. Installation and runtime tasks come from the
project's mise config. `hooks.postinstall` installs JupyterLab, while
`tasks.start` and `tasks.stop` own explicit lifecycle operations and the
first-class `uninstall` owns automatic removal.
Do not install packages, write launch scripts, or start
servers with ad-hoc commands. Use
`execute_ssh_command` only to invoke the documented mise task or inspect logs,
with `cwd` set to the returned `directory`. Before running a task, call
`execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the result; use `start` to launch JupyterLab and `stop` to stop it.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write project files under `~/.dbx-tools/runtime`, invent a route,
publish a direct Sandbox URL, or add a second password or token. All setup and
tasks run as the fixed, unprivileged `sandbox-user`.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "jupyter-lab"`, `openPath: "lab"`, and this mise configuration as the
`config` object:

```toml
[tools]
python = "3.12.12"
uv = "0.11.28"

[hooks]
postinstall = '''
set -e
if [ ! -x .venv/bin/jupyter ]; then
  uv venv > setup.log 2>&1
  uv pip install jupyterlab==4.4.10 >> setup.log 2>&1
fi
'''

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
        *.venv/bin/jupyter*lab*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
nohup setsid .venv/bin/jupyter lab --no-browser --ip 127.0.0.1 --port "$PROJECT_PORT" \
  --ServerApp.root_dir="$PWD" --ServerApp.base_url=/ \
  --IdentityProvider.token= --PasswordIdentityProvider.hashed_password= \
  > server.log 2>&1 < /dev/null &
echo $! > server.pid
'''

[tasks.stop]
run = '''
"$HOME/.local/bin/mise" run uninstall
'''
```

The install hook creates the project-local environment once and installs
the pinned JupyterLab release. Pass the following script as the first-class
`uninstall` option:

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
        *.venv/bin/jupyter*lab*) owned=true ;;
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
the isolated Jupyter process group, including kernels. It always removes
malformed, dead, mismatched, or completed PID files, so repeated removal is
safe. After `add_ssh_project` completes, list the project tasks and
confirm `start` is present. From the returned `directory`, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]`. The `start` task starts JupyterLab on
`127.0.0.1:$PROJECT_PORT` with Jupyter
token and password authentication disabled. The service is loopback-only and
the AppKit project route supplies authenticated access. Installation failures
fail `add_ssh_project`; inspect `setup.log` and `server.log` in the project
directory with `execute_ssh_command` for diagnostics only. To stop JupyterLab,
use the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`; `stop` delegates to
`uninstall`. Project removal invokes `uninstall` automatically and never
invokes `stop`.

Notebooks live in the returned `directory`. Use relative notebook and extension
URLs. Return the project's `openUrl`.
