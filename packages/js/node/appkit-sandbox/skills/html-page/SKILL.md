---
name: html-page
description: Create a self-contained interactive HTML page served from an assigned Databricks Sandbox. Use for browser-only demos such as synthesizers, fractals, particle simulations, visualizations, forms, and small static sites.
---

# HTML Page

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing matching project by passing its `projectId`. Generate one complete,
self-contained `index.html`; keep CSS, JavaScript, workers, assets, and data
inline unless the request requires local files. Do not use external CDNs.

Call `add_ssh_project` with:

- `machineId`: the returned machine id.
- `name`: a short lowercase name.
- `tools`: `{ "python": "3.12.12" }`.
- `env`: `{ "HTML_CONTENT": "<generated page>" }`.
- `install`: the script below.
- `start`: the script below.

Install script:

```sh
set -eu
[ -n "${HTML_CONTENT:-}" ] || { printf 'HTML_CONTENT is required\n' >&2; exit 1; }
printf %s "$HTML_CONTENT" > index.html
```

Start script:

```sh
set -eu
if [ -f server.pid ]; then kill "$(cat server.pid)" 2>/dev/null || true; fi
nohup python -m http.server "$PROJECT_PORT" --bind 127.0.0.1 > server.log 2>&1 < /dev/null &
echo $! > server.pid
```

The runtime runs install only when the project configuration changes and runs
start after installation and once per machine boot. Project removal and reset
terminate `server.pid` and remaining processes rooted in the project directory,
so do not add custom PID validation or wait loops. Use only the returned
`directory`, `port`, `path`, and `openUrl`; keep the server loopback-only and
never publish a direct Sandbox URL.
Return `openUrl` as a Markdown link.
