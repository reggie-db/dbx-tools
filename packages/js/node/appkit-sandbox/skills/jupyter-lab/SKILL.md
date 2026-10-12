---
name: jupyter-lab
description: Run JupyterLab through an authenticated Sandbox project without a separate Jupyter password or token.
---

# JupyterLab

Project workflow is required. Installation and runtime tasks come from the
project's mise config. `hooks.postinstall` installs JupyterLab, while
`tasks.start` and `tasks.stop` own its runtime lifecycle. Do not install packages, write launch scripts, or start
servers with ad-hoc commands. Use `execute_ssh_command` only to invoke the
documented mise task or inspect logs, with `cwd` set to the returned
`directory`. Before running a task, call `execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the result; use `start` to launch JupyterLab and `stop` to stop it.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write project files under `~/.dbx-tools/runtime`, invent a route,
publish a direct Sandbox URL, or add a second password or token.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "jupyter-lab"`, `openPath: "lab"`, and this mise configuration as the
`config` object:

```toml
[tools]
python = "3.12"
uv = "latest"

[hooks]
postinstall = '''
set -e
if [ ! -x .venv/bin/jupyter ]; then
  uv venv > setup.log 2>&1
  uv pip install jupyterlab >> setup.log 2>&1
fi
'''

[tasks.start]
run = '''
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then exit 0; fi
nohup .venv/bin/jupyter lab --no-browser --ip 127.0.0.1 --port "$PROJECT_PORT" \
  --ServerApp.root_dir="$PWD" --ServerApp.base_url=/ \
  --IdentityProvider.token= --PasswordIdentityProvider.hashed_password= \
  > server.log 2>&1 < /dev/null &
echo $! > server.pid
'''

[tasks.stop]
run = '''
if [ -f server.pid ]; then
  kill "$(cat server.pid)" 2>/dev/null || true
fi
'''
```

The install hook creates the project-local environment once and installs
JupyterLab. After `add_ssh_project` completes, list the project tasks and
confirm `start` is present. From the returned `directory`, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]`. The `start` task starts JupyterLab on
`127.0.0.1:$PROJECT_PORT` with Jupyter
token and password authentication disabled. The service is loopback-only and
the AppKit project route supplies authenticated access. Installation failures
fail `add_ssh_project`; inspect `setup.log` and `server.log` in the project
directory with `execute_ssh_command` for diagnostics only. To stop JupyterLab,
use the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`. Project removal
invokes `stop` automatically when available.

Notebooks live in the returned `directory`. Use relative notebook and extension
URLs. Return the project's `openUrl`.
