---
name: particle-physics-lab
description: Create an interactive browser particle and gravity simulation served from an assigned Databricks Sandbox.
---

# Particle Physics Lab

Project workflow is required. Installation and runtime tasks come from the
project's mise config. Do not install packages, write launch scripts, or start
servers with ad-hoc commands. Use `execute_ssh_command` to write the
application files below and to invoke the documented mise task, with `cwd` set
to the returned `directory`. Before running a task, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the result; use `start` to launch the server and `stop` to stop it.
Use only the returned `directory`, `port`, `path`, and `openUrl`.
Do not write demo files under
`~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox URL, or add a
second password or token.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `add_ssh_project` with that `machineId`,
`name: "particle-physics"`, and this mise configuration as the `config`
object:

```toml
[tools]
python = "3.12"

[tasks.start]
run = '''
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then exit 0; fi
nohup python -m http.server "$PROJECT_PORT" --bind 127.0.0.1 > server.log 2>&1 < /dev/null &
echo $! > server.pid
'''

[tasks.stop]
run = '''
if [ -f server.pid ]; then
  kill "$(cat server.pid)" 2>/dev/null || true
fi
'''
```

The `start` task starts a loopback static server in the project directory and is
a no-op while that server is running.

## Application

Write `index.html` in the returned `directory`. Build a self-contained canvas
or WebGL simulation with orbit, fountain, attractor, and collision-box presets.
Include particle count, gravity, drag, trails, color, pause, reset, frame
timing, pointer attractors, and touch input. Use a bounded timestep and reduce
particle count when frame timing degrades. Do not use external CDNs, fonts,
packages, or root-absolute URLs.

After writing `index.html`, list the project tasks and confirm `start` is
present. From the returned `directory`, call `execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]`. To stop the server,
use the same command and directory with
`args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`. Project removal
invokes `stop` automatically when available.

Return the project's `openUrl`.
