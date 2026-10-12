---
name: machine-health
description: Start or open the full Glances Web UI for an assigned Databricks Sandbox.
---

# Machine Health

This built-in service is the only non-Project path. Do not use
`execute_ssh_command` to install a replacement dashboard or create a manual
route. If the request requires custom files or another server, call
`add_ssh_project` with a mise config whose `hooks.postinstall` performs only
installation or preparation and whose `tasks.start` and `tasks.stop` own the
workload lifecycle. Before invoking a project task, use the
`execute_ssh_command` command and argument shape specified by the applicable
skill to list tasks, then run only its documented lifecycle task. Use the
returned directory, port, and open URL.

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "stats"` and return the service path
from the result.

The built-in service installs Glances with its web extras in an isolated remote
virtual environment, binds it to loopback, configures the machine-specific
`/sandbox/metrics/<machine-id>/` prefix, and exposes it only through the owner-scoped
proxy.

If startup fails, inspect `~/.dbx-tools/runtime/glances.log` with
`execute_ssh_command` before retrying.
