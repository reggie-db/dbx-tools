---
name: browser-synth
description: Create an interactive Web Audio synthesizer and oscilloscope demo served from an assigned Databricks Sandbox.
---

# Browser Synth

Create a self-contained browser synthesizer under
`~/.dbx-tools/runtime/browser-synth/` on an assigned machine. The page should
use the Web Audio API and canvas directly, with no external packages, fonts,
samples, or CDNs.

Build a compact instrument with an on-screen keyboard, computer-key bindings,
oscillator selection, attack and release controls, filter cutoff and
resonance, master volume, and live oscilloscope plus spectrum views. Require an
explicit user gesture before creating or resuming the audio context, provide a
visible mute control, and stop oscillators when keys or pointer captures are
released.

Serve the files from a loopback-only static HTTP server. Keep every asset and
navigation URL relative so the app works beneath its registered prefix. Use
`add_ssh_route` with the suffix `/synth` and `stripPrefix: true`, then return the
exact registered path from the tool result.

Audio is generated locally by the user's browser; the Sandbox serves the app
but does not stream audio. This avoids the audio limitation of noVNC and makes
the demo responsive even through a proxied route.
