---
name: particle-physics-lab
description: Create an interactive browser particle and gravity simulation served from an assigned Databricks Sandbox.
---

# Particle Physics Lab

Create a self-contained visual simulation under
`~/.dbx-tools/runtime/particle-physics/` on an assigned machine. Use canvas or
WebGL directly with local JavaScript and CSS; do not add external CDNs, fonts,
or a build step.

Include several presets such as orbit, fountain, attractor, and collision box.
Provide controls for particle count, gravity, drag, trails, color mode, pause,
reset, and frame timing. Support pointer-created attractors and touch input.
Keep the animation stable by using a bounded timestep, cap particle counts to
the device's observed frame rate, and move expensive updates to a worker when
the browser supports it.

Serve the files from a loopback-only static HTTP server. Use relative assets
and navigation paths, register the port with `add_ssh_route` using the suffix
`/particles` and `stripPrefix: true`, and return the exact registered path.

This demo uses ordinary HTTP after loading. Do not add WebSockets or a server
framework unless the user asks for synchronized multi-viewer controls.
