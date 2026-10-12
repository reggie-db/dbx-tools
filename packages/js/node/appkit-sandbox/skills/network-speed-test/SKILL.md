---
name: network-speed-test
description: Measure browser-to-AppKit-to-Sandbox HTTP throughput through a persisted Sandbox project.
---

# Network Speed Test

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
`name: "speed-test"`, and this mise configuration as the `config` object:

```toml
[tools]
python = "3.12"

[tasks.start]
run = '''
[ -f server.py ] || exit 0
stamp="$(cksum < server.py)"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  [ "$stamp" = "$(cat server.stamp 2>/dev/null)" ] && exit 0
  kill "$(cat server.pid)"
  sleep 1
fi
nohup python server.py > server.log 2>&1 < /dev/null &
echo $! > server.pid
printf '%s\n' "$stamp" > server.stamp
'''

[tasks.stop]
run = '''
if [ -f server.pid ]; then
  kill "$(cat server.pid)" 2>/dev/null || true
fi
'''
```

The `start` task waits for `server.py`, starts it, and restarts it only when the
file changes.

## Application

Write `index.html` and `server.py` in the returned `directory`. The page and
server measure download throughput, upload throughput, request latency, and
jitter. Generate payloads locally, cap transfer sizes, and show the sample
count and elapsed time. Do not call public speed-test services or external
CDNs. `server.py` uses the Python standard library, serves `index.html`, and
binds to loopback at `127.0.0.1` on `int(os.environ["PROJECT_PORT"])`. Use
relative fetch URLs.

After writing or changing the files, list the project tasks and confirm
`start` is present. From the returned `directory`, call
`execute_ssh_command` with `command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]` so the task starts or
restarts the server. To stop the server, use the same command and directory
with `args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`. Project removal
invokes `stop` automatically when available. Return the project's `openUrl`.

Label the result as browser-to-AppKit-to-Sandbox performance, including proxy
and SSH forwarding overhead. It is not an ISP or raw workspace network test.
