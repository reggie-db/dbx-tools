---
name: vnc-server
description: Start or open the built-in branded browser desktop on an assigned Databricks Sandbox.
---

# Browser Desktop

Use the built-in desktop service. Do not use `execute_ssh_command` or a project
recipe to install TigerVNC, noVNC, websockify, a window manager, or a parallel
desktop route.

Use `list_ssh_machines` to identify an assigned machine. Call
`start_ssh_machine_service` with `service: "desktop"`. The operation is
idempotent and performs just-in-time setup when the desktop is not already
available.

Return the service `openUrl`. The built-in service owns the loopback-only VNC
listener, noVNC proxy, AppKit route, authentication boundary, dbx.tools desktop
theme, branded wallpaper, mobile remote-resize settings, and default Epiphany
browser. It returns only after the full noVNC web client is responding.

If startup fails, report the tool error. Inspect
`~/.dbx-tools/runtime/desktop/desktop.log` with `execute_ssh_command` only for
diagnostics; do not replace the built-in setup.
