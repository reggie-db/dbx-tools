---
name: jupyter-lab
description: Run JupyterLab through an authenticated Sandbox project without a separate Jupyter password or token.
---

# JupyterLab

Call `list_ssh_machines` first and reuse a matching project when present. Call
`add_ssh_project` with the returned `machineId`, `name: "jupyter-lab"`,
`openPath: "lab"`, `tools: { "python": "3.12.12", "uv": "0.11.28" }`, and
the lifecycle scripts below.

Install script:

```sh
set -eu
uv venv
uv pip install jupyterlab==4.4.10
```

Start script:

```sh
set -eu
if [ -f server.pid ]; then kill "$(cat server.pid)" 2>/dev/null || true; fi
nohup .venv/bin/jupyter lab --no-browser --ip 127.0.0.1 --port "$PROJECT_PORT" \
  --ServerApp.root_dir="$PWD" --ServerApp.base_url=/ \
  --IdentityProvider.token= --PasswordIdentityProvider.hashed_password= \
  > server.log 2>&1 < /dev/null &
echo $! > server.pid
```

The AppKit route supplies authentication, so keep Jupyter loopback-only and do
not add another token or password. The runtime reruns start after a machine
boot and automatically terminates project-local PID files and processes during
reset or removal. Notebooks live in the returned `directory`. Return the
project's `openUrl` as a Markdown link.
