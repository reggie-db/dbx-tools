---
name: network-speed-test
description: Build a polished browser speed-test demo that measures the authenticated AppKit path to an assigned Databricks Sandbox.
---

# Sandbox Speed Test

Build this demo on an assigned machine. Reuse a running machine when possible
and bind the server to `127.0.0.1`; never expose a public listener or return a
localhost or direct Sandbox URL.

Create a dependency-free HTTP service under
`~/.dbx-tools/runtime/speed-test/`. Prefer the available Python standard
library so the demo does not depend on a package registry. The service should
provide:

- A responsive single-page meter at `GET /`.
- A streamed, non-cacheable payload at `GET /download?bytes=<size>`.
- An upload sink at `POST /upload` that drains the body and reports received
  bytes as JSON.
- A small latency endpoint such as `GET /ping` with `Cache-Control: no-store`.

The browser should run a short warmup followed by several timed samples, show
latency, download Mbps, upload Mbps, progress, and a clear rerun control. Use
`performance.now()`, validate payload sizes on the server, cap individual
transfers, and use relative URLs for every request. Do not load fonts, scripts,
or styles from external CDNs.

Register the loopback port with `add_ssh_route` using the suffix `/speed-test`
and `stripPrefix: true`. Return the exact registered path from the tool result.
The user-hash prefix prevents route collisions; it is not an authentication or
security mechanism.

Label the result accurately: it measures the authenticated browser-to-AppKit-
to-Sandbox route, including proxy and tunnel overhead. It is not a general ISP,
workspace backbone, or raw Sandbox network benchmark.
