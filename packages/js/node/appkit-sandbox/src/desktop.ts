import { brandUtils } from "@dbx-tools/shared-core";
import { dbxToolsAssetSvg } from "@dbx-tools/ui/branding/assets";

const DESKTOP_VERSION = "8";
const DESKTOP_DISPLAY = 20;
const DESKTOP_VNC_PORT = 5900 + DESKTOP_DISPLAY;
const DESKTOP_WEB_PORT = 6080;
const KASMVNC_VERSION = "1.5.0";
const KASMVNC_PACKAGE_VERSION = `${KASMVNC_VERSION}-1`;
const KASMVNC_CHECKSUMS = {
  "focal-amd64": "a2951daaa48aa52d09c04a0c6438ab43fe2e7d420485b1bfc36253772799c83c",
  "focal-arm64": "d0188b4e65706f5143fcb000bb29e97d90a3848e7290c9155f7df20585957558",
  "jammy-amd64": "485c190b1d9269fc40fc7205f850ecf71292d737cdb5482e778f2e52f128cd8a",
  "jammy-arm64": "9b21779ee16e514bccd2971dcb3983cd8019a94c8614149dbd717d3702c8dbb5",
  "noble-amd64": "f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e",
  "noble-arm64": "c9199cf4753208bfb69fd016a9780242bebfc43370cc38c97d61e90a3c783e04",
} as const;
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
</svg>`;

const DBX_TOOLS_TERMINAL_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
  <rect x="4" y="6" width="56" height="52" rx="12" fill="${BRAND_COLORS.primary}"/>
  <rect x="8" y="10" width="48" height="44" rx="8" fill="${BRAND_COLORS.primaryHover}"/>
  <path d="m18 23 9 9-9 9" fill="none" stroke="${BRAND_COLORS.surface}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M34 41h12" fill="none" stroke="${BRAND_COLORS.accent}" stroke-width="4" stroke-linecap="round"/>
</svg>`;

/** Browser entry URL for the built-in KasmVNC desktop. */
export function desktopOpenUrl(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const websocketPath = `${normalized.replace(/^\/+/, "")}/websockify`;
  const parameters = new URLSearchParams({
    autoconnect: "1",
    resize: "remote",
    show_dot: "1",
    clipboard_seamless: "0",
    enable_webp: "0",
    kasmvnc_mode_preference: "-1027",
    path: websocketPath,
  });
  return `${normalized}/?${parameters.toString()}`;
}

/** Idempotent remote setup script for the branded dbx.tools browser desktop. */
export function desktopScript(): string {
  const wallpaper = Buffer.from(DBX_TOOLS_WALLPAPER).toString("base64");
  const brandIcon = Buffer.from(dbxToolsAssetSvg.iconDark).toString("base64");
  const brandWebsite = Buffer.from(BRAND.links.website).toString("base64");
  const terminalIcon = Buffer.from(DBX_TOOLS_TERMINAL_ICON).toString("base64");
  const checksumCases = Object.entries(KASMVNC_CHECKSUMS)
    .map(([target, checksum]) => `  ${target}) package_checksum=${checksum} ;;`)
    .join("\n");
  return `set -euo pipefail
runtime="$HOME/.dbx-tools/runtime/desktop"
version_file="$runtime/version"
server_pid="$runtime/kasmvncserver.pid"
legacy_xvnc_pid="$runtime/xvnc.pid"
legacy_session_pid="$runtime/session.pid"
legacy_web_pid="$runtime/websockify.pid"
session_ready="$runtime/session.ready"
session_script="$runtime/start-xfce.sh"
browser_script="$runtime/open-browser"
browser_homepage="$runtime/browser-homepage"
desktop_environment="$runtime/environment"
desktop_runner="$runtime/run"
log_file="$runtime/desktop.log"
wallpaper_svg="$runtime/dbx-tools-wallpaper.svg"
wallpaper_png="$runtime/dbx-tools-wallpaper.png"
brand_icon_svg="$runtime/dbx-tools-icon.svg"
brand_icon="$runtime/dbx-tools-icon.png"
terminal_icon_svg="$runtime/dbx-tools-terminal.svg"
terminal_icon="$runtime/dbx-tools-terminal.png"
mkdir -p "$runtime" "$HOME/.vnc" "$HOME/.config/gtk-3.0" \
  "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml" "$HOME/.config/xfce4" \
  "$HOME/.local/share/applications" "$HOME/.local/share/xfce4/helpers" "$HOME/Desktop"

apt_updated=false
need_packages=false
for command in curl startxfce4 xfce4-panel xfdesktop xfwm4 xfce4-terminal rsvg-convert dbus-run-session epiphany exo-open; do
  command -v "$command" >/dev/null 2>&1 || need_packages=true
done
for package in arc-theme libavcodec-dev libavformat-dev libavutil-dev libswscale-dev papirus-icon-theme xfce4-whiskermenu-plugin; do
  dpkg-query -W -f='\${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || need_packages=true
done
if [ "$need_packages" = true ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'The built-in desktop currently requires an apt-based Sandbox image.\n' >&2
    exit 2
  fi
  sudo -n apt-get update
  apt_updated=true
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    arc-theme ca-certificates curl dbus-x11 epiphany-browser exo-utils fonts-dejavu-core \
    libavcodec-dev libavformat-dev libavutil-dev librsvg2-bin libswscale-dev \
    papirus-icon-theme thunar xfce4-whiskermenu-plugin \
    x11-utils x11-xserver-utils xdg-utils \
    xfce4-panel xfce4-session xfce4-settings xfce4-terminal xfdesktop4 xfwm4
fi

installed_kasmvnc=$(dpkg-query -W -f='\${Version}' kasmvncserver 2>/dev/null || true)
if [ "$installed_kasmvnc" != "${KASMVNC_PACKAGE_VERSION}" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'The built-in desktop currently requires an apt-based Sandbox image.\n' >&2
    exit 2
  fi
  if [ "$apt_updated" = false ]; then
    sudo -n apt-get update
  fi
  test -r /etc/os-release || { printf 'KasmVNC setup requires /etc/os-release.\n' >&2; exit 2; }
  . /etc/os-release
  codename="$VERSION_CODENAME"
  architecture=$(dpkg --print-architecture)
  package_target="$codename-$architecture"
  case "$package_target" in
${checksumCases}
    *) printf 'KasmVNC ${KASMVNC_VERSION} does not provide a package for %s.\n' "$package_target" >&2; exit 2 ;;
  esac
  package_name="kasmvncserver_\${codename}_${KASMVNC_VERSION}_$architecture.deb"
  package_file="$runtime/$package_name"
  package_url="https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/$package_name"
  curl --fail --location --retry 3 --output "$package_file" "$package_url"
  printf '%s  %s\n' "$package_checksum" "$package_file" | sha256sum --check --status || {
    printf 'KasmVNC package checksum verification failed.\n' >&2
    exit 1
  }
  sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$package_file"
fi

test -x "$(command -v kasmvncserver)" || { printf 'kasmvncserver is unavailable after package setup.\n' >&2; exit 1; }
test -x "$(command -v kasmvncpasswd)" || { printf 'kasmvncpasswd is unavailable after package setup.\n' >&2; exit 1; }
test -r /usr/share/kasmvnc/www/index.html || { printf 'KasmVNC web client is unavailable after package setup.\n' >&2; exit 1; }

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
  stop_pid "$server_pid"
  stop_pid "$legacy_web_pid"
  stop_pid "$legacy_session_pid"
  stop_pid "$legacy_xvnc_pid"
  kasmvncserver -kill :${DESKTOP_DISPLAY} >/dev/null 2>&1 || true
  rm -f "$session_ready"
fi

printf %s '${wallpaper}' | base64 -d >"$wallpaper_svg"
rsvg-convert --width 1600 --height 1000 "$wallpaper_svg" >"$wallpaper_png"
printf %s '${brandIcon}' | base64 -d >"$brand_icon_svg"
rsvg-convert --width 64 --height 64 "$brand_icon_svg" >"$brand_icon"
printf %s '${brandWebsite}' | base64 -d >"$browser_homepage"
printf %s '${terminalIcon}' | base64 -d >"$terminal_icon_svg"
rsvg-convert --width 64 --height 64 "$terminal_icon_svg" >"$terminal_icon"

printf 'export DISPLAY=:%s\\n' '${DESKTOP_DISPLAY}' >"$desktop_environment"
chmod 600 "$desktop_environment"
cat >"$desktop_runner" <<'EOF'
#!/bin/sh
set -eu
. "$HOME/.dbx-tools/runtime/desktop/environment"
exec "$@"
EOF
chmod 700 "$desktop_runner"

cat >"$browser_script" <<'EOF'
#!/bin/sh
export GTK_A11Y=none
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
if [ "$#" -eq 0 ]; then
  set -- "$(cat "$HOME/.dbx-tools/runtime/desktop/browser-homepage")"
fi
exec epiphany "$@"
EOF
chmod 700 "$browser_script"

cat >"$HOME/.config/gtk-3.0/gtk.css" <<'EOF'
#XfcePanelWindow {
  background-color: ${BRAND_COLORS.primary};
  color: ${BRAND_COLORS.surface};
}
#XfcePanelWindow button {
  color: ${BRAND_COLORS.surface};
  border-color: transparent;
  background-color: transparent;
  border-radius: 8px;
  margin: 3px;
}
#XfcePanelWindow button:hover,
#XfcePanelWindow button:checked {
  background-color: ${BRAND_COLORS.primaryHover};
}
EOF

if [ -r /etc/xdg/xfce4/panel/default.xml ]; then
  cp /etc/xdg/xfce4/panel/default.xml \
    "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
fi

cat >"$HOME/.config/mimeapps.list" <<'EOF'
[Default Applications]
text/html=dbx-tools-browser.desktop
x-scheme-handler/http=dbx-tools-browser.desktop
x-scheme-handler/https=dbx-tools-browser.desktop
EOF

cat >"$HOME/.local/share/applications/dbx-tools-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=dbx tools Browser
Comment=Browse the web from the Sandbox desktop
Exec=$browser_script %U
Icon=$brand_icon
Terminal=false
Categories=Network;WebBrowser;
MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;
EOF

cat >"$HOME/.local/share/xfce4/helpers/dbx-tools-browser.desktop" <<EOF
[Desktop Entry]
Version=1.0
Icon=$brand_icon
Type=X-XFCE-Helper
Name=dbx tools Browser
StartupNotify=true
X-XFCE-Binaries=$browser_script;
X-XFCE-Category=WebBrowser
X-XFCE-Commands=$browser_script;
X-XFCE-CommandsWithParameter=$browser_script "%s";
EOF

cat >"$HOME/.config/xfce4/helpers.rc" <<'EOF'
WebBrowser=dbx-tools-browser
EOF

rm -f "$HOME/Desktop/Web Browser.desktop"

cat >"$HOME/.local/share/applications/dbx-tools-terminal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Terminal
Comment=Open the Sandbox desktop terminal
Exec=xfce4-terminal
Icon=$terminal_icon
Terminal=false
Categories=System;TerminalEmulator;
EOF
chmod 700 "$HOME/.local/share/applications/dbx-tools-terminal.desktop"
rm -f "$HOME/Desktop/Terminal.desktop"

cat >"$HOME/.vnc/kasmvnc.yaml" <<'EOF'
desktop:
  resolution:
    width: 1600
    height: 1000
  allow_resize: true
  pixel_depth: 24
network:
  protocol: http
  interface: 127.0.0.1
  websocket_port: ${DESKTOP_WEB_PORT}
  use_ipv4: true
  use_ipv6: false
  ssl:
    pem_certificate:
    pem_key:
    require_ssl: false
encoding:
  max_frame_rate: 30
  rect_encoding_mode:
    min_quality: 7
    max_quality: 9
    consider_lossless_quality: 10
    rectangle_compress_threads: auto
  video_encoding_mode:
    jpeg_quality: -1
    webp_quality: -1
    max_resolution:
      width: 1920
      height: 1080
    enter_video_encoding_mode:
      time_threshold: 1
      area_threshold: 45%
    exit_video_encoding_mode:
      time_threshold: 2
    scaling_algorithm: progressive_bilinear
    webp_encoding_time: 30
  video_streaming_mode:
    codec: h264
server:
  http:
    headers:
      - Cross-Origin-Embedder-Policy=require-corp
      - Cross-Origin-Opener-Policy=same-origin
    httpd_directory: /usr/share/kasmvnc/www
  auto_shutdown:
    no_user_session_timeout: never
    active_user_session_timeout: never
    inactive_user_session_timeout: never
command_line:
  prompt: false
EOF

if [ ! -s "$HOME/.kasmpasswd" ]; then
  kasm_password=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')
  printf '%s\n%s\n' "$kasm_password" "$kasm_password" | \
    kasmvncpasswd -u dbx-tools -r -w "$HOME/.kasmpasswd" >/dev/null
fi

cat >"$session_script" <<'EOF'
#!/bin/sh
set -eu
runtime="$HOME/.dbx-tools/runtime/desktop"
ready="$runtime/session.ready"
log_file="$runtime/desktop.log"
wallpaper="$runtime/dbx-tools-wallpaper.png"
brand_icon="$runtime/dbx-tools-icon.svg"
rm -f "$ready"
if [ -z "\${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
  exec dbus-run-session -- "$0"
fi
startxfce4 >>"$log_file" 2>&1 &
xfce_pid=$!
for _ in $(seq 1 160); do
  if pgrep -x xfce4-panel >/dev/null 2>&1 && pgrep -x xfdesktop >/dev/null 2>&1 && pgrep -x xfwm4 >/dev/null 2>&1; then
    set_xfconf() {
      channel="$1"
      property="$2"
      type="$3"
      value="$4"
      if xfconf-query -c "$channel" -p "$property" >/dev/null 2>&1; then
        xfconf-query -c "$channel" -p "$property" -s "$value" >/dev/null 2>&1 || true
      else
        xfconf-query -c "$channel" -p "$property" --create -t "$type" -s "$value" >/dev/null 2>&1 || true
      fi
    }
    xdg-mime default dbx-tools-browser.desktop text/html >/dev/null 2>&1 || true
    xdg-mime default dbx-tools-browser.desktop x-scheme-handler/http >/dev/null 2>&1 || true
    xdg-mime default dbx-tools-browser.desktop x-scheme-handler/https >/dev/null 2>&1 || true
    xdg-settings set default-web-browser dbx-tools-browser.desktop >/dev/null 2>&1 || true
    gsettings set org.gnome.Epiphany homepage-url "$(cat "$runtime/browser-homepage")" >/dev/null 2>&1 || true
    set_xfconf xsettings /Net/ThemeName string Arc-Dark
    set_xfconf xsettings /Net/IconThemeName string Papirus-Dark
    set_xfconf xsettings /Gtk/FontName string 'DejaVu Sans 10'
    set_xfconf xfwm4 /general/theme string Arc-Dark
    set_xfconf xfce4-panel /panels/panel-1/size uint 36
    set_xfconf xfce4-panel /plugins/plugin-1 string whiskermenu
    set_xfconf xfce4-panel /plugins/plugin-1/button-icon string "$brand_icon"
    set_xfconf xfce4-panel /plugins/plugin-1/button-title string 'dbx tools'
    set_xfconf xfce4-panel /plugins/plugin-1/show-button-title bool true
    properties=$(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep -E '/(last-image|image-path)$' || true)
    if [ -z "$properties" ]; then
      properties='/backdrop/screen0/monitor0/workspace0/last-image
/backdrop/screen0/monitorVNC-0/workspace0/last-image
/backdrop/screen0/monitorDefault-0/workspace0/last-image'
    fi
    printf '%s\n' "$properties" | while IFS= read -r property; do
      [ -n "$property" ] || continue
      xfconf-query -c xfce4-desktop -p "$property" --create -t string -s "$wallpaper" >/dev/null 2>&1 || true
      style=$(printf '%s' "$property" | sed -E 's/(last-image|image-path)$/image-style/')
      xfconf-query -c xfce4-desktop -p "$style" --create -t int -s 5 >/dev/null 2>&1 || true
    done
    xfdesktop --reload >/dev/null 2>&1 || true
    xfce4-panel --restart >/dev/null 2>&1 || true
    touch "$ready"
    break
  fi
  kill -0 "$xfce_pid" 2>/dev/null || exit 1
  sleep 0.25
done
test -f "$ready" || { printf 'Xfce desktop shell did not become ready.\n' >&2; exit 1; }
wait "$xfce_pid"
EOF
chmod 700 "$session_script"

if ! [ -s "$server_pid" ] || ! kill -0 "$(cat "$server_pid")" 2>/dev/null; then
  kasmvncserver -kill :${DESKTOP_DISPLAY} >/dev/null 2>&1 || true
  rm -f "$session_ready"
  nohup kasmvncserver :${DESKTOP_DISPLAY} -fg -select-de xfce -xstartup "$session_script" \
    -geometry 1600x1000 -depth 24 -interface 127.0.0.1 -websocketPort ${DESKTOP_WEB_PORT} \
    -disableBasicAuth -SecurityTypes None >"$log_file" 2>&1 </dev/null &
  echo $! >"$server_pid"
fi

for _ in $(seq 1 160); do
  [ -f "$session_ready" ] && break
  kill -0 "$(cat "$server_pid")" 2>/dev/null || break
  sleep 0.25
done
[ -f "$session_ready" ] || { printf 'Xfce desktop session did not become ready.\n' >&2; tail -80 "$log_file" >&2; exit 1; }

python3 - ${DESKTOP_WEB_PORT} <<'PY'
import sys
import time
import urllib.request

port = int(sys.argv[1])
for _ in range(240):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
            body = response.read(65536)
            if response.status == 200 and b"KasmVNC" in body:
                raise SystemExit(0)
    except Exception:
        time.sleep(0.5)
raise SystemExit("KasmVNC web client did not become ready")
PY
printf '%s\n' '${DESKTOP_VERSION}' >"$version_file"`;
}

export const desktopPorts = {
  vnc: DESKTOP_VNC_PORT,
  web: DESKTOP_WEB_PORT,
} as const;
