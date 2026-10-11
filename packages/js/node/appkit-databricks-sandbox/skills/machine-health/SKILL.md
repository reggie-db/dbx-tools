---
name: machine-health
description: Start or open the full Glances Web UI for an assigned Databricks Sandbox.
---

# Machine Health

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "stats"` and return the service path
from the result.

The built-in service installs Glances with its web extras in an isolated remote
virtual environment, binds it to loopback, configures the machine-specific
`/sandbox/.../stats/` prefix, and exposes it only through the owner-scoped proxy.

If startup fails, inspect `~/.dbx-tools/runtime/glances.log` with
`execute_ssh_command` before retrying.
