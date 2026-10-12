---
name: freedoom-desktop
description: Launch the redistributable Freedoom game in the built-in browser desktop on an assigned Sandbox.
---

# Freedoom Desktop

Reuse an assigned Sandbox. Call `start_ssh_machine_service` with
`service: "desktop"` before game setup. Do not install or configure TigerVNC,
noVNC, websockify, a window manager, a VNC password, or another desktop route.
The built-in service owns those concerns and returns the desktop `openUrl`.

Call `add_ssh_project` with `name: "freedoom-desktop"` before using
`execute_ssh_command` for game-specific files or launch scripts. Keep those
files in the returned `directory`; do not write them under
`~/.dbx-tools/runtime`.

Inspect the operating system and package manager before installing game
packages. Install only the distribution's freely redistributable Freedoom data
and a compatible maintained engine such as Crispy Doom or PrBoom+. Do not
download or request proprietary Doom data. Locate `freedoom1.wad` or
`freedoom2.wad` instead of assuming a distribution-specific path.

Launch the game on the built-in desktop display with `DISPLAY=:20` from a
project-local script. Keep the process detached and write its log in the
project directory. Return the desktop service `openUrl`, not the project's HTTP
route, localhost, or a direct Sandbox URL.
