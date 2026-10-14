---
name: html-page
description: Serve a self-contained interactive HTML page from the user's Lakebox. Use for browser-only demos such as synthesizers, fractals, particle simulations, visualizations, forms, and small static sites.
---

# HTML Page

Generate one complete, self-contained page; keep CSS, JavaScript, workers,
assets, and data inline. Do not use external CDNs.

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
