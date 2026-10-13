---
name: freedoom-desktop
description: Launch the redistributable Freedoom game in the built-in browser desktop on an assigned Sandbox.
---

# Freedoom Desktop

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Use a route-less project with the built-in desktop as a declared
`serviceDependencies: ["desktop"]` requirement. Do not install or configure
KasmVNC, another VNC server, a window manager, a VNC password, or another
desktop route. Never enumerate `/tmp/.X11-unix`, infer or rewrite `DISPLAY`, or
edit a game launcher to target a display.

Call `add_ssh_project` with `machineId`, `name: "freedoom-desktop"`, `route: false`, the desktop
service dependency, and the following script as the first-class `postinstall`
option. The runtime waits for the desktop dependency before project setup.

```sh
set -eu
log="$PWD/freedoom.log"
marker="$PWD/.freedoom-installed"
lock="$PWD/.freedoom-install.lock"
find_engine() { command -v crispy-doom || command -v prboom-plus || true; }
find_wad() { find /usr/share /usr/local/share -name 'freedoom[12].wad' 2>/dev/null | sort -r | head -n 1; }
if [ ! -f "$marker" ]; then
  while ! mkdir "$lock" 2>/dev/null; do sleep 0.2; done
  trap 'rm -rf "$lock"' EXIT HUP INT TERM
  if [ ! -f "$marker" ]; then
    engine="$(find_engine)"
    wad="$(find_wad)"
    if [ -z "$engine" ] || [ -z "$wad" ]; then
      sudo -n apt-get update >> "$log" 2>&1
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        freedoom crispy-doom >> "$log" 2>&1 ||
        sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
          freedoom prboom-plus >> "$log" 2>&1
    fi
    touch "$marker"
  fi
  rm -rf "$lock"
  trap - EXIT HUP INT TERM
fi
engine="$(find_engine)"
wad="$(find_wad)"
runner="$HOME/.dbx-tools/runtime/desktop/run"
if [ -z "$engine" ] || [ -z "$wad" ] || [ ! -x "$runner" ]; then
  echo "Freedoom or the built-in desktop is unavailable" >> "$log"
  exit 1
fi
if [ -f game.pid ] && kill -0 "$(cat game.pid)" 2>/dev/null; then exit 0; fi
nohup "$runner" "$engine" -iwad "$wad" >> "$log" 2>&1 < /dev/null &
echo $! > game.pid
```

Pass the following script as the first-class `uninstall` option:

```sh
if [ -f game.pid ]; then
  pid="$(tr -d ' \n' < game.pid)"
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
fi
pkill -x crispy-doom 2>/dev/null || true
pkill -x prboom-plus 2>/dev/null || true
rm -f game.pid
```

The postinstall hook uses check-lock-check plus a completion marker so package
installation runs once, then launches the game through the service-owned
`~/.dbx-tools/runtime/desktop/run` wrapper. Project removal invokes uninstall
and then performs directory-wide pid cleanup. Do not download or request
proprietary Doom data.

Return the desktop service `openUrl` from machine state after it is `ready`.
This project has no HTTP route. Never return localhost or a direct Sandbox URL.
