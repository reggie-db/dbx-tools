---
name: vnc-server
description: Start or open the built-in branded browser desktop on an assigned Databricks Sandbox.
---

# Browser Desktop

Use the built-in desktop service. Do not use `execute_ssh_command` or a project
recipe to install KasmVNC, another VNC server, a window manager, or a parallel
desktop route.

Use `list_ssh_machines` to identify an assigned machine. Call
`start_ssh_machine_service` with `service: "desktop"`. The operation is
idempotent and performs just-in-time setup when the desktop is not already
available.

The service owns the display assignment. Never enumerate `/tmp/.X11-unix`,
infer a display number, set or rewrite `DISPLAY`, edit a project launcher to
target a display, or start, stop, replace, or reconfigure the desktop stack.
When a graphical application must run on the desktop, start this service
first, then create a project whose mise `hooks.postinstall` installs the
application and whose `tasks.start` and `tasks.stop` own its runtime lifecycle
through the
service-owned `~/.dbx-tools/runtime/desktop/run` wrapper. Follow the
`freedoom-desktop` recipe for the setup project options. Before invoking a
project task, use the `execute_ssh_command` command and argument shape specified
by the applicable skill to list tasks, then run only its documented lifecycle
task. Do not install or launch desktop applications with ad-hoc commands.

Return the service `openUrl`. The built-in service owns the loopback-only VNC
listener and native KasmVNC web client, AppKit route, authentication boundary,
dbx.tools viewer branding, Arc Dark and Papirus desktop theme, branded wallpaper,
Xfce panel and application menu, H.264 motion streaming, mobile remote-resize
settings, manual clipboard synchronization, and a Sandbox-compatible default
browser and native terminal available from the application menu. It returns
only after the desktop shell and browser client are responding.

If startup fails, report the tool error. Inspect
`~/.dbx-tools/runtime/desktop/desktop.log` with `execute_ssh_command` only for
diagnostics; do not replace the built-in setup.
