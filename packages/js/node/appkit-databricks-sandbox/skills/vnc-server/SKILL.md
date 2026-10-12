---
name: vnc-server
description: Create a browser VNC desktop on an assigned SSH machine with noVNC and an AppKit reverse-proxy-aware route.
---

# Browser VNC

Use the assigned machine only. Confirm the desired desktop and package manager
before installing system packages.

Prefer TigerVNC plus noVNC because noVNC supplies touch controls and lets the
client select its WebSocket path. Bind both VNC and websockify to loopback.
Never expose either port directly, and never return a localhost or direct
Sandbox URL to the user.

1. Use `execute_ssh_command` to install or locate a VNC server, noVNC, and
   websockify, then create a user-owned startup script under
   `~/.dbx-tools/runtime/vnc/`.
2. Start the VNC display and run `novnc_proxy` on an unused loopback port.
3. Use `add_ssh_route` with the suffix `/vnc`, the noVNC loopback port, and
   `stripPrefix: true`. Use the registered path returned by the tool; do not
   construct the user-hash prefix yourself.
4. Return a URL beneath that registered path ending in
   `/vnc.html?autoconnect=1&resize=remote&path=<registered-path-without-leading-slash>/websockify`.

The `path` query value is relative to the public origin and must include the
full registered route without a leading slash. AppKit owns the WebSocket
upgrade and strips the registered prefix before forwarding `/websockify`. The
user hash prevents route collisions and is not an authentication mechanism.
Do not use a hard-coded `ws://localhost` URL; the browser must use the current
public origin and the registered AppKit path.

Keep credentials in the remote VNC password file with user-only permissions.
Do not place passwords or tokens in the route URL.
