---
name: machine-health
description: Open the native health overview for an assigned Databricks Sandbox.
---

# Machine Health

Use `list_ssh_machines` to identify an assigned machine and return its stable
`/sandbox/<machine-id>/stats` path.

The built-in view samples memory, disk, load, CPU count, and uptime through the
Databricks Sandbox execution API. It installs nothing on the machine and remains
scoped to the current AppKit user.
