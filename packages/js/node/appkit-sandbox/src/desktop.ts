import { brandUtils } from "@dbx-tools/shared-core";
import { dbxToolsAssetSvg } from "@dbx-tools/ui/branding/assets";

const DESKTOP_VERSION = "2";
const DESKTOP_DISPLAY = 20;
const DESKTOP_VNC_PORT = 5900 + DESKTOP_DISPLAY;
const DESKTOP_WEB_PORT = 6080;
const BRAND = brandUtils.defaultBrandContext;
const BRAND_COLORS = BRAND.colors;
const WALLPAPER_LOGO = dbxToolsAssetSvg.logoDark.replace(
  "<svg ",
  '<svg x="500" y="378" width="600" height="135" ',
);

const DBX_TOOLS_WALLPAPER = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000" viewBox="0 0 1600 1000">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0B161B"/>
      <stop offset="0.55" stop-color="${BRAND_COLORS.primary}"/>
      <stop offset="1" stop-color="${BRAND_COLORS.primaryHover}"/>
    </linearGradient>
    <pattern id="grid" width="64" height="64" patternUnits="userSpaceOnUse">
      <path d="M64 0H0V64" fill="none" stroke="${BRAND_COLORS.surface}" stroke-opacity="0.045"/>
    </pattern>
  </defs>
  <rect width="1600" height="1000" fill="url(#background)"/>
  <rect width="1600" height="1000" fill="url(#grid)"/>
  <path d="M0 780C310 650 475 920 780 775s500-220 820-55v280H0Z" fill="${BRAND_COLORS.accent}" fill-opacity="0.13"/>
  <path d="M0 835c300-125 510 105 790-10s500-170 810-65" fill="none" stroke="${BRAND_COLORS.accent}" stroke-width="4" stroke-opacity="0.7"/>
  ${WALLPAPER_LOGO}
  <text x="800" y="558" text-anchor="middle" fill="${BRAND_COLORS.muted}" font-family="${BRAND.typography.sans}" font-size="24" letter-spacing="5">SANDBOX DESKTOP</text>
  <text x="1488" y="926" text-anchor="end" fill="${BRAND_COLORS.surface}" fill-opacity="0.58" font-family="${BRAND.typography.mono}" font-size="18">BUILD · TEST · EXPLORE</text>
</svg>`;

/** Browser entry URL for the built-in noVNC desktop. */
export function desktopOpenUrl(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const websocketPath = `${normalized.replace(/^\/+/, "")}/websockify`;
  return `${normalized}/vnc.html?autoconnect=1&resize=remote&show_dot=1&keep_device_awake=1&path=${encodeURIComponent(websocketPath)}`;
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
for command in Xtigervnc openbox tint2 feh rsvg-convert websockify dbus-run-session epiphany; do
  command -v "$command" >/dev/null 2>&1 || need_packages=true
done
if [ "$need_packages" = true ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'The built-in desktop currently requires an apt-based Sandbox image.\n' >&2
    exit 2
  fi
  sudo -n apt-get update
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    dbus-x11 epiphany-browser feh fonts-dejavu-core librsvg2-bin novnc openbox tint2 \
    tigervnc-standalone-server websockify x11-utils x11-xserver-utils xdg-utils xterm
fi

test -r /usr/share/novnc/vnc.html || { printf 'noVNC vnc.html is unavailable after package setup.\n' >&2; exit 1; }

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
window.active.title.bg.color: ${BRAND_COLORS.primary}
window.active.title.text.color: ${BRAND_COLORS.surface}
window.active.button.unpressed.image.color: ${BRAND_COLORS.muted}
window.inactive.title.bg.color: ${BRAND_COLORS.foreground}
window.inactive.title.text.color: ${BRAND_COLORS.muted}
window.inactive.button.unpressed.image.color: ${BRAND_COLORS.border}
menu.items.bg.color: ${BRAND_COLORS.foreground}
menu.items.text.color: ${BRAND_COLORS.surface}
menu.items.active.bg.color: ${BRAND_COLORS.primaryHover}
menu.items.active.text.color: ${BRAND_COLORS.surface}
menu.title.bg.color: ${BRAND_COLORS.primary}
menu.title.text.color: ${BRAND_COLORS.surface}
osd.bg.color: ${BRAND_COLORS.primary}
osd.label.text.color: ${BRAND_COLORS.surface}
EOF

cat >"$HOME/.config/openbox/rc.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme><name>dbx-tools</name><titleLayout>NLIMC</titleLayout></theme>
  <desktops><number>2</number><firstdesk>1</firstdesk><names><name>Build</name><name>Explore</name></names></desktops>
  <applications><application class="*"><decor>yes</decor></application></applications>
  <menu><file>menu.xml</file></menu>
</openbox_config>
EOF

cat >"$HOME/.config/openbox/menu.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<openbox_menu xmlns="http://openbox.org/3.4/menu">
  <menu id="root-menu" label="Applications">
    <item label="Web Browser"><action name="Execute"><command>epiphany</command></action></item>
    <item label="Terminal"><action name="Execute"><command>xterm</command></action></item>
    <separator/>
    <item label="Exit desktop"><action name="Exit"/></item>
  </menu>
</openbox_menu>
EOF

cat >"$HOME/.config/mimeapps.list" <<'EOF'
[Default Applications]
text/html=org.gnome.Epiphany.desktop
x-scheme-handler/http=org.gnome.Epiphany.desktop
x-scheme-handler/https=org.gnome.Epiphany.desktop
EOF

cat >"$HOME/.config/tint2/tint2rc" <<'EOF'
rounded = 8
border_width = 0
background_color = ${BRAND_COLORS.primary} 92
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
task_font_color = ${BRAND_COLORS.surface} 100
clock_font_color = ${BRAND_COLORS.muted} 100
clock_lclick_command = xterm
EOF

cat >"$HOME/.config/openbox/autostart" <<EOF
xsetroot -solid '${BRAND_COLORS.primary}' &
feh --no-fehbg --bg-scale '$wallpaper_png' &
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
import sys
import time
import urllib.request

port = int(sys.argv[1])
for _ in range(240):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/vnc.html", timeout=2) as response:
            body = response.read(65536)
            if response.status == 200 and b"noVNC" in body:
                raise SystemExit(0)
    except Exception:
        time.sleep(0.5)
raise SystemExit("noVNC web client did not become ready")
PY
printf '%s\n' '${DESKTOP_VERSION}' >"$version_file"`;
}

export const desktopPorts = {
  vnc: DESKTOP_VNC_PORT,
  web: DESKTOP_WEB_PORT,
} as const;
