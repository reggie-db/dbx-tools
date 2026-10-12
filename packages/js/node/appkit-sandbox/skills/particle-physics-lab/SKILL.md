---
name: particle-physics-lab
description: Create an interactive browser particle and gravity simulation served from an assigned Databricks Sandbox.
---

# Particle Physics Lab

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch this demo. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write demo
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with
`name: "particle-physics"` and
`config: { "tools": { "python": "3.12" } }`. Work in the returned
`directory`.

Build a self-contained canvas or WebGL simulation with orbit, fountain,
attractor, and collision-box presets. Include particle count, gravity, drag,
trails, color, pause, reset, frame timing, pointer attractors, and touch input.
Use a bounded timestep and reduce particle count when frame timing degrades. Do
not use external CDNs, fonts, packages, or root-absolute URLs.

Start a loopback server from the project directory with
`mise exec -- python -m http.server "$PROJECT_PORT" --bind 127.0.0.1`. Return
the project's `openUrl`.
