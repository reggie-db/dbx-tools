---
name: freedoom-desktop
description: Launch the redistributable Freedoom game in a browser-accessible Sandbox desktop.
---

# Freedoom Desktop

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to install or launch the desktop. Use only the
returned `directory`, `port`, `path`, and `openUrl`. Do not write launch files
under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox URL, or
create or display a VNC password. A direct SSH-only launch is incomplete.

Reuse an assigned Sandbox. Call `add_ssh_project` with
`name: "freedoom-desktop"`. Use its returned `directory` for scripts and logs
and its generated `port` for noVNC.

Keep user-space tools and launch tasks in the project's mise config when they
are available through mise. Use system packages only for desktop and game
components that mise does not provide.

Before installing system packages, inspect the operating system and package
manager and obtain confirmation. Install a minimal window manager, TigerVNC,
noVNC/websockify, GNOME Web (`epiphany-browser`) or another maintained browser,
the distribution's Freedoom data package, and a compatible engine such as
Crispy Doom or PrBoom+.

Use only the freely redistributable `freedoom1.wad` or `freedoom2.wad` from the
installed package. Do not download or request proprietary Doom data. Locate the
IWAD instead of assuming a distribution-specific path.

Bind VNC and websockify to loopback. Use the VNC server's no-auth mode only on
loopback. Do not create a VNC password because the AppKit project route already
authenticates browser access. Launch the desktop and Freedoom from scripts in
the project directory.

When noVNC is ready, update the same project by calling `add_ssh_project` with its
`projectId` and
`openPath: "vnc.html?autoconnect=1&resize=remote&path=<project-path-without-leading-slash>/websockify"`.
Return the updated `openUrl`.
