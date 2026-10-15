---
name: realtime-whiteboard
description: Deploy or run a realtime collaborative whiteboard app as a Lakebox service using WBO and user-scoped WebSocket routing.
---

# Realtime Whiteboard

Use the pinned Docker/OCI image through `create_lakebox_service`. Do not run a
container CLI directly.

Call `create_lakebox_service` once:

```json
{
  "name": "realtime-whiteboard",
  "image": "docker.io/library/node:24-alpine",
  "mounts": [{ "source": "whiteboard", "target": "/data" }],
  "command": [
    "sh",
    "-c",
    "set -eu; mkdir -p /data/app /data/boards; cd /data/app; [ -f server/server.mjs ] || wget -qO- https://github.com/lovasoa/whitebophir/archive/refs/tags/v2.17.1.tar.gz | tar -xz --strip-components=1; [ -d node_modules ] || npm install --omit=dev --ignore-scripts --no-audit --no-fund; WBO_HISTORY_DIR=/data/boards HOST=127.0.0.1 PORT=\"$SERVICE_PORT\" exec node server/server.mjs"
  ]
}
```

Boards persist in `~/whiteboard`. The first start downloads and installs WBO.
WebSocket clients use relative URLs, so the route prefix stays intact. Return
the service `openUrl` as a Markdown link.
