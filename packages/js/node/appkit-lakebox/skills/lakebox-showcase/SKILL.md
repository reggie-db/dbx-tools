---
name: lakebox-showcase
description: Recommend and deploy high-value single-user Lakebox browser demos. Use when a user asks what they can do with Lakebox, wants fun Lakebox or Docker demo ideas, or needs a one-port unprivileged showcase.
---

# Lakebox Showcase

For a broad question such as "what can I do with Lakebox?", recommend a short
list before deploying anything:

1. A retro desktop, paint app, or pixel-art editor built as a self-contained
   HTML page. Use JS Paint and Piskel as design inspiration.
2. A browser music player or sequencer inspired by Webamp or Efflux.
3. A data-transformation workbench inspired by CyberChef or IT Tools.
4. A diagram, drawing, or whiteboard app inspired by Excalidraw or diagrams.net.
5. A self-contained 3D scene, puzzle, or arcade game.
6. JupyterLab for a real stateful development environment.
7. A network speed test for demonstrating the AppKit-to-Lakebox route.

Prefer a maintained Docker/OCI image when the user names an existing
application. If the image is not already known, use `web_search` to find the
upstream repository or image documentation. Verify that it can run
unprivileged, bind `127.0.0.1:$SERVICE_PORT`, expose one HTTP port, and work
beneath `$SERVICE_PATH`. Deploy it only through `create_lakebox_service`; never
run `docker`, `podman`, or `buildah` directly.

For a custom experience, prefer the first five because browser-only code
packaged in a small image is reliable behind the user-scoped Lakebox route. Use
the packaged `jupyter-lab` or `network-speed-test` skill when the user selects
one of those exact demos.

Do not recommend these as primary Lakebox showcases:

- PairDrop, LAN Games, or multiplayer collaboration. Lakebox routes and homes
  are user-scoped, so cross-user interaction has little value.
- Webtop. Lakebox already provides a built-in desktop and terminal.
- Quake, console emulators, or ROM-based apps. Assets, licensing, device access,
  or elevated runtime requirements make them unreliable defaults.
- Large local ML applications such as offline translation. Model downloads and
  memory use make the first run slow and fragile.
- An upstream image that assumes port 80, root, a dedicated hostname, or `/`
  asset paths. Use it only after proving that it listens on
  `127.0.0.1:$SERVICE_PORT` and works beneath `$SERVICE_PATH`.

When the user asks to deploy a showcase but does not select one, generate a
polished self-contained retro desktop with two or three interactive mini apps.
Replace the placeholder HTML below with the complete page, then call
`create_lakebox_service` once:

```json
{
  "name": "lakebox-showcase",
  "image": "docker.io/library/python:3.12-alpine",
  "env": {
    "HTML_CONTENT": "<generated self-contained retro desktop page>"
  },
  "command": [
    "sh",
    "-c",
    "mkdir -p /site && printf %s \"$HTML_CONTENT\" > /site/index.html && exec python -m http.server \"$SERVICE_PORT\" --bind 127.0.0.1 --directory /site"
  ]
}
```

Keep all CSS, JavaScript, assets, workers, and data inline. Do not use external
CDNs. Return the service `openUrl` as a Markdown link.
