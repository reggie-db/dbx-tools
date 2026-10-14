---
name: html-page
description: Deploy or host a web app, website, HTML page, Three.js scene, 3D game, visualization, or browser demo as a Lakebox service. Use when asked to deploy an app, service, site, or page and return an open URL.
---

# HTML Page

Generate one complete, self-contained page; keep CSS, JavaScript, workers,
assets, and data inline. Do not use external CDNs.

Route requests such as "deploy this app", "serve this page", "host this web
demo", or "deploy it as a service" here when the result can run entirely in a
browser. This includes interactive Three.js scenes and small games.

Call `create_lakebox_service` once. Use a short lowercase `name` for each
distinct page:

```json
{
  "name": "html-page",
  "image": "docker.io/library/python:3.12-alpine",
  "env": { "HTML_CONTENT": "<generated page>" },
  "command": [
    "sh",
    "-c",
    "mkdir -p /site && printf %s \"$HTML_CONTENT\" > /site/index.html && exec python -m http.server \"$SERVICE_PORT\" --bind 127.0.0.1 --directory /site"
  ]
}
```

The call returns after the server is listening. Call it again with the same
name to replace the page. Return the service `openUrl` as a Markdown link.
