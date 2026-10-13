---
name: ttyd-terminal
description: Start or open the built-in ttyd browser terminal on an assigned Databricks Sandbox.
---

# ttyd Terminal

This built-in service is a hidden, machine-owned mise project with a reserved
route. `start_ssh_machine_service` owns its installation, lifecycle, readiness,
and route. Do not use `execute_ssh_command` to install a replacement terminal
or create a manual route. If the request requires custom files or another
server, call
`add_ssh_project` with a mise config using first-class `tools`, `postinstall`, and `uninstall` options when practical. Raw `config` follows https://mise.jdx.dev/schema/mise.json. `postinstall` may prepare or launch a workload that remains active until `uninstall`; removal never auto-runs `start` or `stop`. Before invoking a project task, use the
`execute_ssh_command` command and argument shape specified by the applicable
skill to list tasks, then run only its documented lifecycle task. Use the
returned directory, port, and open URL.

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "terminal"`. Do not install another
terminal server or create a parallel route.

The tool returns an async lifecycle iterator. Observe it through `starting` until `ready` or `error`, and return the service `openUrl` only after `ready`. Remote status files preserve the same progress after browser refresh. The AppKit proxy owns HTTP,
WebSocket, authentication, and the route path used by ttyd.

If startup fails, report the tool error and inspect the remote
`~/.dbx-tools/runtime/ttyd.log` with `execute_ssh_command` before retrying.
