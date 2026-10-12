---
name: browser-synth
description: Create an interactive Web Audio synthesizer and oscilloscope demo served from an assigned Databricks Sandbox.
---

# Browser Synth

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch this demo. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write demo
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with `name: "browser-synth"`
and `config: { "tools": { "python": "3.12" } }`.

Create the app in the returned `directory`. Use one self-contained HTML file
with Web Audio and canvas. Include an on-screen keyboard, computer-key input,
oscillator selection, envelope and filter controls, volume, mute, oscilloscope,
and spectrum views. Stop oscillators on key and pointer release. Do not use
external packages, fonts, samples, or CDNs.

From the project directory, start a loopback server with
`mise exec -- python -m http.server "$PROJECT_PORT" --bind 127.0.0.1`. Use
relative URLs so the page works below the project path. Return the project's
`openUrl`.
