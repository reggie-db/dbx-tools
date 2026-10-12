---
name: realtime-whiteboard
description: Build a collaborative browser whiteboard that demonstrates owner-scoped WebSocket routing through an assigned Databricks Sandbox.
---

# Realtime Whiteboard

Build a small collaborative whiteboard on an assigned machine. Prefer Bun's
built-in HTTP and WebSocket server when Bun is already available; otherwise
use an installed runtime with native or existing WebSocket support rather than
adding a framework by default.

Serve one self-contained page with pointer and touch drawing, color and stroke
controls, undo, clear, connection state, and a small participant count. Keep a
bounded in-memory history so a newly connected browser receives the current
board. Validate message shapes, cap message and history sizes, and broadcast
only drawing operations rather than screenshots.

Bind the server to loopback and register it with `add_ssh_route` using the
suffix `/whiteboard` and `stripPrefix: true`. Return the exact registered path.
The browser must derive `ws://` or `wss://` from the current public origin and
resolve its socket endpoint relative to the registered page path. Never use a
hard-coded localhost socket or omit the full user-prefixed route from the
browser URL.

AppKit forwards standard HTTP Upgrade requests and strips the registered route
prefix before proxying when `stripPrefix: true`. Protocols that require a
fixed root socket URL, raw TCP, UDP, or a second unregistered port will not work
through this route.
