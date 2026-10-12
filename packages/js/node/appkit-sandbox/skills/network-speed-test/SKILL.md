---
name: network-speed-test
description: Measure browser-to-AppKit-to-Sandbox HTTP throughput through a persisted Sandbox project.
---

# Network Speed Test

Project workflow is required. Call `add_ssh_project` before any
`execute_ssh_command` used to create, install, or launch this demo. Use only
the returned `directory`, `port`, `path`, and `openUrl`. Do not write demo
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, or add a second password or token.

Reuse an assigned Sandbox. Call `add_ssh_project` with `name: "speed-test"`
and `config: { "tools": { "python": "3.12" } }`. Put all files in the
returned `directory`.

Create a local page and server that measure download throughput, upload
throughput, request latency, and jitter. Generate payloads locally, cap transfer
sizes, and show the sample count and elapsed time. Do not call public speed-test
services or external CDNs.

Bind the server to loopback at `127.0.0.1:$PROJECT_PORT` and run it with `mise exec`. Use
relative fetch URLs and return the project's `openUrl`.

Label the result as browser-to-AppKit-to-Sandbox performance, including proxy
and SSH forwarding overhead. It is not an ISP or raw workspace network test.
