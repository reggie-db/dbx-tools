---
name: databricks-sandbox-terminal
description: Open the built-in mobile-friendly browser terminal on an assigned Databricks Sandbox.
---

# Databricks Sandbox Terminal

Use `list_ssh_machines` to identify an assigned machine. Return its stable
`/sandbox/<machine-id>/terminal` path. Do not install another terminal server or
create a parallel route.

The AppKit plugin owns authentication, machine startup, the workspace gRPC PTY,
and the browser's streamed HTTP transport. If opening fails, report the viewer
error; do not fall back to installing a remote terminal daemon.
