---
name: fractal-lab
description: Create a self-contained interactive Mandelbrot and Julia-set browser demo served from an assigned Databricks Sandbox.
---

# Fractal Lab

Create a visually polished, dependency-free fractal explorer under
`~/.dbx-tools/runtime/fractal-lab/` on an assigned machine. Reuse an existing
machine and avoid external CDNs.

Use one HTML document with local CSS and JavaScript. Render Mandelbrot and
Julia sets to a canvas with an inline Web Worker so zooming and palette changes
do not block the interface. Include pointer-centered zoom, drag-to-pan, reset,
iteration and palette controls, current coordinates, render duration, and a
small preset gallery. Adapt resolution or iteration count while interacting,
then refine the image after input settles.

Serve the directory from a loopback-only static HTTP server. Use relative
assets and browser APIs only; do not emit root-absolute `/api`, `/assets`, or
worker URLs. Register the port with `add_ssh_route` using the suffix
`/fractal-lab` and `stripPrefix: true`, then return the exact registered path.

This demo needs ordinary HTTP only. Do not add a WebSocket server, framework,
or build step unless the user asks for collaborative or server-rendered
features.
