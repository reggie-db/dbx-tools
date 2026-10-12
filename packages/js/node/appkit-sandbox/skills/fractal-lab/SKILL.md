---
name: fractal-lab
description: Create a self-contained interactive Mandelbrot and Julia-set browser demo served from an assigned Databricks Sandbox.
---

# Fractal Lab

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch this demo. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write demo
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with `name: "fractal-lab"`
and `config: { "tools": { "python": "3.12" } }`. Create the app in the
returned `directory`.

Use one local HTML document with CSS, JavaScript, canvas, and an inline Web
Worker. Include Mandelbrot and Julia modes, pointer-centered zoom, pan, reset,
iteration and palette controls, coordinates, render duration, and presets.
Reduce work during interaction and refine after input settles. Do not use
external CDNs, fonts, packages, or root-absolute URLs.

Start the loopback server from the project directory with
`mise exec -- python -m http.server "$PROJECT_PORT" --bind 127.0.0.1`. Return
the project's `openUrl`.
