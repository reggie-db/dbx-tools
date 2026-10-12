const DESKTOP_VERSION = "1";
const DESKTOP_DISPLAY = 20;
const DESKTOP_VNC_PORT = 5900 + DESKTOP_DISPLAY;
const DESKTOP_WEB_PORT = 6080;

const DBX_TOOLS_WALLPAPER = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b161b"/>
      <stop offset="0.55" stop-color="#1b3139"/>
      <stop offset="1" stop-color="#0e538b"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0H0V64" fill="none" stroke="#ffffff" stroke-opacity="0.045"/>
    </pattern>
  </defs>
  <rect width="1600" height="1000" fill="url(#background)"/>
  <rect width="1600" height="1000" fill="url(#grid)"/>
  <path d="M0 780C310 650 475 920 780 775s500-220 820-55v280H0Z" fill="#00a972" fill-opacity="0.13"/>
  <path d="M0 835c300-125 510 105 790-10s500-170 810-65" fill="none" stroke="#00a972" stroke-width="4" stroke-opacity="0.7"/>
  <g transform="translate(112 128)">
    <rect width="98" height="98" rx="18" fill="#ff3621"/>
    <path d="M24 27h50v12H42v12h27v12H42v25H24Z" fill="#fff"/>
    <text x="0" y="160" fill="#fff" font-family="Inter,DejaVu Sans,sans-serif" font-size="64" font-weight="700">dbx.tools</text>
    <text x="2" y="205" fill="#b7d7e8" font-family="Inter,DejaVu Sans,sans-serif" font-size="24" letter-spacing="5">SANDBOX DESKTOP</text>
  </g>
  <text x="1488" y="926" text-anchor="end" fill="#fff" fill-opacity="0.58" font-family="DejaVu Sans Mono,monospace" font-size="18">BUILD · TEST · EXPLORE</text>
</svg>`;

/** Browser entry URL for the built-in noVNC desktop. */
export function desktopOpenUrl(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const websocketPath = `${normalized.replace(/^\/+/, "")}/websockify`;
  return `${normalized}/vnc.html?autoconnect=1&resize=remote&path=${encodeURIComponent(websocketPath)}`;
}

/** Idempotent remote setup script for the branded dbx.tools browser desktop. */
export function desktopScript(): string {
  const wallpaper = Buffer.from(DBX_TOOLS_WALLPAPER).toString("base64");
  return `set -euo pipefail
runtime="$HOME/.dbx-tools/runtime/desktop"
version_file="$runtime/version"
xvnc_pid="$runtime/xvnc.pid"
session_pid="$runtime/session.pid"
web_pid="$runtime/websockify.pid"
log_file="$runtime/desktop.log"
wallpaper_svg="$runtime/dbx-tools-wallpaper.svg"
wallpaper_png="$runtime/dbx-tools-wallpaper.png"
mkdir -p "$runtime" "$HOME/.config/openbox" "$HOME/.config/tint2" "$HOME/.themes/dbx-tools/openbox-3"

need_packages=false
for command in Xtigervnc openbox tint2 feh rsvg-convert websockify dbus-run-session; do
  command -v "$command" >/dev/null 2>&1 || need_packages=true
done
if [ "$need_packages" = true ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'The built-in desktop currently requires an apt-based Sandbox image.\n' >&2
    exit 2
  fi
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    dbus-x11 feh fonts-dejavu-core librsvg2-bin novnc openbox tint2 \
    tigervnc-standalone-server websockify x11-utils x11-xserver-utils xterm
fi

stop_pid() {
  pid_file="$1"
  if [ -s "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
    kill "$(cat "$pid_file")"
    for _ in $(seq 1 40); do
      kill -0 "$(cat "$pid_file")" 2>/dev/null || break
      sleep 0.25
    done
  fi
  rm -f "$pid_file"
}

if [ ! -f "$version_file" ] || [ "$(cat "$version_file")" != "${DESKTOP_VERSION}" ]; then
  stop_pid "$web_pid"
  stop_pid "$session_pid"
  stop_pid "$xvnc_pid"
fi

printf %s '${wallpaper}' | base64 -d >"$wallpaper_svg"
rsvg-convert --width 1600 --height 1000 "$wallpaper_svg" >"$wallpaper_png"

cat >"$HOME/.themes/dbx-tools/openbox-3/themerc" <<'EOF'
window.active.title.bg.color: #1b3139
window.active.title.text.color: #ffffff
window.active.button.unpressed.image.color: #b7d7e8
window.inactive.title.bg.color: #13252c
window.inactive.title.text.color: #8faab7
window.inactive.button.unpressed.image.color: #6f8995
menu.items.bg.color: #13252c
menu.items.text.color: #ffffff
menu.items.active.bg.color: #0e538b
menu.items.active.text.color: #ffffff
menu.title.bg.color: #1b3139
menu.title.text.color: #ffffff
osd.bg.color: #1b3139
osd.label.text.color: #ffffff
EOF

cat >"$HOME/.config/openbox/rc.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme><name>dbx-tools</name><titleLayout>NLIMC</titleLayout></theme>
  <desktops><number>2</number><firstdesk>1</firstdesk><names><name>Build</name><name>Explore</name></names></desktops>
  <applications><application class="*"><decor>yes</decor></application></applications>
</openbox_config>
EOF

cat >"$HOME/.config/tint2/tint2rc" <<'EOF'
rounded = 8
border_width = 0
background_color = #1b3139 92
panel_items = TSC
panel_size = 100% 42
panel_position = bottom center horizontal
panel_padding = 10 4 10
taskbar_mode = multi_desktop
task_text = 1
task_icon = 1
task_background_id = 0
task_active_background_id = 0
task_font = DejaVu Sans 10
task_font_color = #ffffff 100
clock_font_color = #b7d7e8 100
clock_lclick_command = xterm
EOF

cat >"$HOME/.config/openbox/autostart" <<EOF
xsetroot -solid '#1b3139' &
feh --no-fehbg --bg-fill '$wallpaper_png' &
tint2 -c '$HOME/.config/tint2/tint2rc' &
EOF
chmod 700 "$HOME/.config/openbox/autostart"

display=:${DESKTOP_DISPLAY}
if ! [ -s "$xvnc_pid" ] || ! kill -0 "$(cat "$xvnc_pid")" 2>/dev/null; then
  nohup Xtigervnc "$display" -localhost yes -SecurityTypes None -geometry 1600x1000 \
    -depth 24 -AlwaysShared >"$log_file" 2>&1 </dev/null &
  echo $! >"$xvnc_pid"
fi

for _ in $(seq 1 80); do
  if DISPLAY="$display" xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.25
done
DISPLAY="$display" xdpyinfo >/dev/null 2>&1 || { printf 'TigerVNC display did not become ready.\n' >&2; exit 1; }

if ! [ -s "$session_pid" ] || ! kill -0 "$(cat "$session_pid")" 2>/dev/null; then
  nohup env DISPLAY="$display" dbus-run-session -- openbox-session >>"$log_file" 2>&1 </dev/null &
  echo $! >"$session_pid"
fi

if ! [ -s "$web_pid" ] || ! kill -0 "$(cat "$web_pid")" 2>/dev/null; then
  nohup websockify --web=/usr/share/novnc 127.0.0.1:${DESKTOP_WEB_PORT} \
    127.0.0.1:${DESKTOP_VNC_PORT} >>"$log_file" 2>&1 </dev/null &
  echo $! >"$web_pid"
fi

python3 - ${DESKTOP_WEB_PORT} <<'PY'
import socket
import sys
import time

port = int(sys.argv[1])
for _ in range(240):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            raise SystemExit(0)
    except OSError:
        time.sleep(0.5)
raise SystemExit("noVNC did not become ready")
PY
printf '%s\n' '${DESKTOP_VERSION}' >"$version_file"`;
}

export const desktopPorts = {
  vnc: DESKTOP_VNC_PORT,
  web: DESKTOP_WEB_PORT,
} as const;
