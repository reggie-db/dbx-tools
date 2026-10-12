---
name: freedoom-desktop
description: Launch an open-source Freedoom game inside a browser-accessible noVNC desktop on an assigned Databricks Sandbox.
---

# Freedoom Desktop

Use the assigned machine only. This recipe extends the packaged `vnc-server`
workflow: create a lightweight loopback-only desktop, expose it through noVNC,
and launch Freedoom inside that desktop.

Before installing system packages, inspect the operating system and available
package manager, report the packages you intend to install, and obtain the
user's confirmation. Prefer a minimal window manager such as Openbox or
Fluxbox, TigerVNC, noVNC/websockify, Freedoom data files, and an available
compatible engine such as Crispy Doom or PrBoom+. Verify exact package names
with the machine's package manager instead of assuming them.

Use only the freely redistributable Freedoom IWAD supplied by the installed
package. Do not download or request proprietary Doom game data. Locate the
installed `freedoom1.wad` or `freedoom2.wad` rather than hard-coding a distro-
specific path.

Store startup scripts, logs, and the VNC password beneath
`~/.dbx-tools/runtime/freedoom/`. Bind VNC and websockify to loopback. Start a
modest desktop resolution, launch the selected Doom engine on that display,
and use `add_ssh_route` with the suffix `/freedoom` and `stripPrefix: true`.
Use the exact registered path returned by the tool.

Return a noVNC URL ending in
`/vnc.html?autoconnect=1&resize=remote&path=<registered-path-without-leading-slash>/websockify`.
The WebSocket path must include the full registered user-prefixed route and
must derive its scheme and host from the current browser origin. A direct
`ws://localhost` connection cannot work through AppKit.

Set expectations before presenting the demo: standard noVNC carries display,
keyboard, and pointer input but does not provide game audio. Keep credentials
out of URLs and restrict password files to the Sandbox user.
