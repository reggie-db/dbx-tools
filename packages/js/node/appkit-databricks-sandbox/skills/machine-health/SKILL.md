---
name: machine-health
description: Start or open the built-in Glances health overview for an assigned SSH machine.
---

# Machine Health

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "stats"` and return the service path
from the result.

The built-in service installs Glances in an isolated remote virtual environment,
binds it to loopback, configures the machine-specific `/sandbox/.../stats/`
prefix, and exposes it only through the owner-scoped SSH proxy.

If startup fails, inspect `~/.dbx-tools/runtime/glances.log` with
`execute_ssh_command` before retrying.
