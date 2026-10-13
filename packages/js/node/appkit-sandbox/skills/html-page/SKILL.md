---
name: html-page
description: Create a self-contained interactive HTML page served from an assigned Databricks Sandbox. Use for browser-only demos such as synthesizers, fractals, particle simulations, visualizations, forms, and small static sites.
---

# HTML Page

Project workflow is required. Put page creation and the initial server launch
in `hooks.postinstall` so `add_ssh_project` reports setup progress and returns
only after the page is ready. Do not define `start`, `stop`, or hidden tasks.
The first-class `uninstall` owns automatic removal.

Use only the returned `directory`, `port`, `path`, and `openUrl`. Do not write
files under `~/.dbx-tools/runtime`, invent a route, publish a direct Sandbox
URL, add a password or token, or use external CDNs. All setup runs as the
fixed, unprivileged `sandbox-user`, and the static server binds only to
loopback.

## Choose the page

Generate one complete, self-contained `index.html` from the request. Keep CSS,
JavaScript, assets, workers, and data inline unless the user explicitly needs
multiple local files. Use relative URLs.

Examples include:

- A Web Audio synthesizer with keyboard input, envelope and filter controls,
  oscilloscope, and spectrum views.
- A Mandelbrot and Julia explorer with zoom, pan, palettes, presets, and an
  inline Web Worker.
- A particle and gravity simulation with presets, bounded timesteps, pointer
  interaction, and adaptive particle counts.
- A dashboard, form, canvas experiment, documentation page, or static site.

Use a backend-focused skill instead when the requested showcase needs package
installation, server APIs, persistence, WebSockets, notebooks, or another
backend capability.

## Setup project options

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing HTML project on that machine when its purpose matches the request.
Choose a short lowercase project name. Generate the complete page first. Call
`add_ssh_project` with that `machineId`, the chosen `name`,
`env: { "HTML_CONTENT": "<generated page>" }`, and the complete TOML below as
`config`:

```toml
[tools]
python = "3.12.12"

[hooks]
postinstall = '''
set -eu
[ -n "${HTML_CONTENT:-}" ] || {
  printf 'HTML_CONTENT is required\n' >&2
  exit 1
}
printf %s "$HTML_CONTENT" > index.html
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *python*http.server*)
          if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ]; then exit 0; fi
          ;;
      esac
      ;;
  esac
  "$HOME/.local/bin/mise" run uninstall
fi
nohup setsid python -m http.server "$PROJECT_PORT" --bind 127.0.0.1 > server.log 2>&1 < /dev/null &
echo $! > server.pid
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if python -c 'import os, socket; s=socket.create_connection(("127.0.0.1", int(os.environ["PROJECT_PORT"])), 0.2); s.close()' 2>/dev/null; then
    exit 0
  fi
  sleep 0.2
done
cat server.log >&2
exit 1
'''
```

Put the generated page in first-class `env.HTML_CONTENT`. Do not embed the HTML
in the TOML. The postinstall hook writes `$HTML_CONTENT` to `index.html`, starts
the loopback server, and waits until it accepts connections.

Pass this script as the first-class `uninstall` option:

```sh
set -eu
if [ -f server.pid ]; then
  pid="$(tr -d '[:space:]' < server.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$process_command" in
        *python*http.server*) owned=true ;;
        *) owned=false ;;
      esac
      if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ] && [ "$owned" = true ]; then
        pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"
        if [ "$pgid" = "$pid" ]; then
          kill -TERM -- "-$pid" 2>/dev/null || true
        else
          pkill -P "$pid" 2>/dev/null || true
          kill -TERM "$pid" 2>/dev/null || true
        fi
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          if [ "$pgid" = "$pid" ]; then
            pgrep -g "$pid" >/dev/null 2>&1 || break
          else
            kill -0 "$pid" 2>/dev/null || break
          fi
          sleep 0.2
        done
        if [ "$pgid" = "$pid" ]; then
          if pgrep -g "$pid" >/dev/null 2>&1; then
            kill -KILL -- "-$pid" 2>/dev/null || true
          fi
        elif kill -0 "$pid" 2>/dev/null; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      fi
      ;;
  esac
fi
rm -f server.pid
```

To apply a changed page, call `add_ssh_project` again with the existing
`projectId`, updated `env.HTML_CONTENT`, and the same TOML. Project removal
invokes `uninstall` automatically. Return the project's `openUrl` as a Markdown link.
