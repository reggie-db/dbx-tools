---
name: dinotty-terminal
description: Start or open the built-in mobile-friendly DinoTTY browser terminal on an assigned Databricks Sandbox.
---

# DinoTTY Terminal

Use `list_ssh_machines` to identify an assigned machine. Use
`start_ssh_machine_service` with `service: "terminal"`; do not install another
terminal server or create a parallel route.

Return the service path from the tool result. The AppKit proxy owns HTTP,
WebSocket, authentication, route-prefix stripping, and the root-relative paths
used by DinoTTY.

If startup fails, report the tool error and inspect the remote
`~/.dbx-tools/runtime/dinotty.log` with `execute_ssh_command` before retrying.
