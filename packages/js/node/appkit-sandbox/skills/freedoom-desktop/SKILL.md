---
name: freedoom-desktop
description: Launch the redistributable Freedoom game in the built-in browser desktop on an assigned Sandbox.
---

# Freedoom Desktop

Call `list_ssh_machines` first and use only a returned machine `id`. Reuse an
existing project on that machine when `projects` already contains this recipe.
Call `start_ssh_machine_service` with
`service: "desktop"` before game setup. Do not install or configure KasmVNC,
another VNC server, a window manager, a VNC password, or another desktop route.
The built-in service owns those concerns and returns the desktop `openUrl`.
It also owns the display assignment. Never enumerate `/tmp/.X11-unix`, infer a
display number, set or rewrite `DISPLAY`, or edit a game launcher to target a
display.

Game installation and runtime tasks come from the project's mise config.
`hooks.postinstall` installs the game, while `tasks.start` and `tasks.stop`
own its runtime lifecycle. After
the desktop service is ready, pass the setup options below to
`add_ssh_project`. Do not install packages, write launch scripts, or start the
game with an ad-hoc command. Use `execute_ssh_command` only to invoke the
documented mise task or inspect logs, with `cwd` set to the returned
`directory`. Before running a task, call `execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" tasks ls --name-only --hidden"]`.
Evaluate the result; use `start` to launch the game and `stop` to stop it. Do
not write game files under `~/.dbx-tools/runtime`.

## Setup project options

Call `add_ssh_project` with `machineId`, `name: "freedoom-desktop"`, and this
mise configuration as the `config` object:

```toml
[hooks]
postinstall = '''
log="$PWD/freedoom.log"
find_engine() { command -v crispy-doom || command -v prboom-plus || true; }
find_wad() { find /usr/share /usr/local/share -name 'freedoom[12].wad' 2>/dev/null | sort -r | head -n 1; }
engine="$(find_engine)"
wad="$(find_wad)"
if [ -z "$engine" ] || [ -z "$wad" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Freedoom setup requires an apt-based Sandbox image" >> "$log"
    exit 0
  fi
  sudo -n apt-get update >> "$log" 2>&1
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    freedoom crispy-doom >> "$log" 2>&1 ||
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      freedoom prboom-plus >> "$log" 2>&1
  engine="$(find_engine)"
  wad="$(find_wad)"
fi
if [ -z "$engine" ] || [ -z "$wad" ]; then
  echo "Freedoom engine or WAD is unavailable" >> "$log"
  exit 0
fi
'''

[tasks.start]
run = '''
log="$PWD/freedoom.log"
engine="$(command -v crispy-doom || command -v prboom-plus || true)"
wad="$(find /usr/share /usr/local/share -name 'freedoom[12].wad' 2>/dev/null | sort -r | head -n 1)"
if [ -z "$engine" ] || [ -z "$wad" ]; then
  echo "Freedoom engine or WAD is unavailable" >> "$log"
  exit 1
fi
if [ -f game.pid ] && kill -0 "$(cat game.pid)" 2>/dev/null; then exit 0; fi
runner="$HOME/.dbx-tools/runtime/desktop/run"
if [ ! -x "$runner" ]; then
  echo "Start the built-in desktop service before launching Freedoom" >> "$log"
  exit 0
fi
nohup "$runner" "$engine" -iwad "$wad" >> "$log" 2>&1 < /dev/null &
echo $! > game.pid
'''

[tasks.stop]
run = '''
if [ -f game.pid ]; then
  pid="$(tr -d ' \n' < game.pid)"
  pkill -P "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || true
fi
pkill -x crispy-doom 2>/dev/null || true
pkill -x prboom-plus 2>/dev/null || true
'''
```

The install hook installs only the distribution's freely redistributable
Freedoom data and a maintained engine (Crispy Doom, falling back to PrBoom+).
After `add_ssh_project` completes, list the project tasks, confirm `start` is
present. From the returned `directory`, call `execute_ssh_command` with
`command: "sh"` and
`args: ["-lc", "\"$HOME/.local/bin/mise\" run start"]`. The `start` task
locates `freedoom2.wad` or `freedoom1.wad` instead of assuming a
distribution-specific path and launches the game detached through the
service-owned `~/.dbx-tools/runtime/desktop/run` wrapper, which supplies the
assigned display. It is a no-op while the game is running and logs to
`freedoom.log` in the project directory. To relaunch after the game exits, use
the same start invocation. To stop the game, use the same command and
directory with `args: ["-lc", "\"$HOME/.local/bin/mise\" run stop"]`.
Project removal invokes `stop` automatically when available. Do not download
or request proprietary Doom data.

Return the desktop service `openUrl`, not the project's HTTP route, localhost,
or a direct Sandbox URL.
