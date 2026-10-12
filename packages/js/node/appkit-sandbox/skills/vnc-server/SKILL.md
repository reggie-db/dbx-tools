---
name: vnc-server
description: Create a browser VNC desktop on an assigned Sandbox through a persisted, authenticated project route.
---

# Browser VNC

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to install or launch the desktop. Use only the
returned `directory`, `port`, `path`, and `openUrl`. Do not write launch files
under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox URL, or
create or display a VNC password. A direct SSH-only launch is incomplete.

Reuse an assigned Sandbox. Call `add_ssh_project` with `name: "vnc-desktop"`.
Use the returned `directory` for startup scripts and logs and the returned
`port` for noVNC.

Keep user-space tools and launch tasks in the project's mise config when they
are available through mise. Use system packages only for desktop components
that mise does not provide.

Before installing system packages, inspect the operating system and package
manager and obtain confirmation. Prefer TigerVNC, a minimal window manager,
noVNC/websockify, and GNOME Web (`epiphany-browser`). If GNOME Web is not
available, install another maintained browser.

Bind VNC and websockify to loopback. Do not configure a VNC password: the VNC
listener is loopback-only and the AppKit route is the authenticated boundary.
Use the VNC server's no-auth security mode only with loopback binding. Never
return a localhost or direct Sandbox URL.

After noVNC is running, call `add_ssh_project` again with the returned
`projectId` and an `openPath` of
`vnc.html?autoconnect=1&resize=remote&path=<project-path-without-leading-slash>/websockify`.
Use the public `path` returned by the first call to build that query value.
Return the updated `openUrl`.
