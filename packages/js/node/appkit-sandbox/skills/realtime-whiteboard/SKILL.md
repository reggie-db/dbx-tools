---
name: realtime-whiteboard
description: Build a collaborative browser whiteboard that demonstrates owner-scoped WebSocket routing through an assigned Databricks Sandbox.
---

# Realtime Whiteboard

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch this demo. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write demo
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with
`name: "realtime-whiteboard"` and
`config: { "tools": { "bun": "latest" } }`. Work in the returned
`directory` and use `mise exec -- bun` for commands.

Build one self-contained page with pointer and touch drawing, color and stroke
controls, undo, clear, connection state, and participant count. Use Bun's HTTP
and WebSocket APIs. Keep bounded in-memory history, validate message shapes,
cap message sizes, and broadcast drawing operations instead of screenshots.

Bind the server to loopback at `127.0.0.1:$PROJECT_PORT`. The browser must derive `ws://`
or `wss://` from the current public origin and connect below the returned
project path. Use relative HTTP URLs. Return the project's `openUrl`.

AppKit forwards standard HTTP Upgrade requests and strips the project path when
`stripPrefix` is true. Raw TCP, UDP, fixed-root socket URLs, and a second
unregistered port are not supported.
