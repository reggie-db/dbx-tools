---
name: jupyter-lab
description: Run JupyterLab through an authenticated Sandbox project without a separate Jupyter password or token.
---

# JupyterLab

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch JupyterLab. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write project
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with `name: "jupyter-lab"`,
`openPath: "lab"`, and
`config: { "tools": { "python": "3.12", "uv": "latest" } }`.

Work in the returned `directory`. Create a project-local environment and
install JupyterLab with `mise exec -- uv venv` and
`mise exec -- uv pip install jupyterlab`.

Start JupyterLab on `127.0.0.1:$PROJECT_PORT` with its base URL set to `/` and
with Jupyter token and password authentication disabled. The service is
loopback-only and the AppKit project route supplies authenticated access. Do
not create or display a second password, token, or direct Sandbox URL.

Use relative notebook and extension URLs. Return the project's `openUrl`.
