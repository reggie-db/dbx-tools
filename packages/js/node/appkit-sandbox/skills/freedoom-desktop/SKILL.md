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
The trusted desktop image must already provide Freedoom and either Crispy Doom
or PrBoom+. Run everything as the fixed `sandbox-user`; do not install system
packages from this recipe.

```sh
set -eu
log="$PWD/freedoom.log"
find_engine() { command -v crispy-doom || command -v prboom-plus || true; }
find_wad() { find /usr/share /usr/local/share -name 'freedoom[12].wad' 2>/dev/null | sort -r | head -n 1; }
engine="$(find_engine)"
wad="$(find_wad)"
runner="$HOME/.dbx-tools/runtime/desktop/run"
if [ -z "$engine" ] || [ -z "$wad" ] || [ ! -x "$runner" ]; then
  printf '%s\n' "Freedoom prerequisites or the built-in desktop are unavailable" >> "$log"
  exit 1
fi
if [ -f game.pid ]; then
  pid="$(tr -d '[:space:]' < game.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      if kill -0 "$pid" 2>/dev/null && [ "$process_cwd" = "$PWD" ]; then
        case "$process_command" in
          *crispy-doom*freedoom*.wad*|*prboom-plus*freedoom*.wad*) exit 0 ;;
        esac
      fi
      ;;
  esac
  rm -f game.pid
fi
nohup setsid "$runner" "$engine" -iwad "$wad" >> "$log" 2>&1 < /dev/null &
echo $! > game.pid
```

Pass the following script as the first-class `uninstall` option:

```sh
set -eu
if [ -f game.pid ]; then
  pid="$(tr -d '[:space:]' < game.pid)"
  case "$pid" in
    ''|*[!0-9]*) ;;
    *)
      process_cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
      process_command="$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      owned=false
      case "$process_command" in
        *crispy-doom*freedoom*.wad*|*prboom-plus*freedoom*.wad*) owned=true ;;
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
rm -f game.pid
```

The runtime's home-owned check-lock-check lifecycle serialization replaces any
recipe-local lock or installation marker. The postinstall hook only validates
the trusted prerequisites and launches the game through the service-owned
`~/.dbx-tools/runtime/desktop/run` wrapper. Uninstall validates the recorded
PID's command and working directory before terminating its isolated process
group, removes stale PID files, and is safe to rerun. Do not use broad
`pkill -x crispy-doom` or `pkill -x prboom-plus` cleanup because another
project can run the same engine. Project removal invokes uninstall and then
performs directory-wide PID cleanup. Do not download or request proprietary
Doom data.

Return the desktop service `openUrl` from machine state after it is `ready`.
This project has no HTTP route. Never return localhost or a direct Sandbox URL.
