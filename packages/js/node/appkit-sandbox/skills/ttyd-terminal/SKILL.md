---
name: ttyd-terminal
description: Start or open the built-in ttyd browser terminal on an assigned Databricks Sandbox.
---

# ttyd Terminal

This built-in service is the only non-Project path. Do not use
`execute_ssh_command` to install a replacement terminal or create a manual
route. If the request requires custom files or another server, call
`add_ssh_project` with a mise config whose `hooks.postinstall` performs only
installation or preparation and whose `tasks.start` and `tasks.stop` own the
workload lifecycle. Before invoking a project task, use the
`execute_ssh_command` command and argument shape specified by the applicable
skill to list tasks, then run only its documented lifecycle task. Use the
returned directory, port, and open URL.

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "terminal"`. Do not install another
terminal server or create a parallel route.

Return the service path from the tool result. The AppKit proxy owns HTTP,
WebSocket, authentication, and the route path used by ttyd.

If startup fails, report the tool error and inspect the remote
`~/.dbx-tools/runtime/ttyd.log` with `execute_ssh_command` before retrying.
