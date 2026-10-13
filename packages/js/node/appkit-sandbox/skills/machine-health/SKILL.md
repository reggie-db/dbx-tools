---
name: machine-health
description: Start or open the full Glances Web UI for an assigned Databricks Sandbox.
---

# Machine Health

This built-in service is a hidden, machine-owned mise project with a reserved
route. `start_ssh_machine_service` owns its installation, lifecycle, readiness,
and route. Do not use `execute_ssh_command` to install a replacement dashboard
or create a manual route. If the request requires custom files or another
server, call
`add_ssh_project` with a mise config using first-class `tools`, `postinstall`, and `uninstall` options when practical. Raw `config` follows https://mise.jdx.dev/schema/mise.json. `postinstall` may prepare or launch a workload that remains active until `uninstall`; removal never auto-runs `start` or `stop`. Before invoking a project task, use the
`execute_ssh_command` command and argument shape specified by the applicable
skill to list tasks, then run only its documented lifecycle task. Use the
returned directory, port, and open URL.

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "stats"`. The tool returns only
after Glances and its authenticated route are ready. Return the service
`openUrl`; no additional health check is required.

The built-in service installs Glances with its web extras in an isolated remote
virtual environment, binds it to loopback, configures the machine-specific
`/sandbox/metrics/<machine-id>/` prefix, and exposes it only through the owner-scoped
proxy.

If startup fails, inspect `~/.dbx-tools/runtime/glances.log` with
`execute_ssh_command` before retrying.
