#!/bin/sh
set -eu

kasmvnc_version=1.5.0
kasmvnc_package_version="$kasmvnc_version-1"
installed_kasmvnc=$(dpkg-query -W -f='${Version}' kasmvncserver 2>/dev/null || true)
missing=false
for command in startxfce4 xfce4-panel xfdesktop xfwm4 xfce4-terminal \
  rsvg-convert dbus-run-session epiphany exo-open; do
  command -v "$command" >/dev/null 2>&1 || missing=true
done
for package in arc-theme hicolor-icon-theme xfce4-whiskermenu-plugin; do
  dpkg-query -W -f='${Status}' "$package" 2>/dev/null |
    grep -q 'install ok installed' || missing=true
done
if [ "$missing" = false ] && [ "$installed_kasmvnc" = "$kasmvnc_package_version" ]; then
  exit 0
fi

command -v apt-get >/dev/null 2>&1
test -r /etc/os-release
. /etc/os-release
codename="$VERSION_CODENAME"
architecture=$(dpkg --print-architecture)
package_target="$codename-$architecture"
case "$package_target" in
  focal-amd64) package_checksum="a2951daaa48aa52d09c04a0c6438ab43fe2e7d420485b1bfc36253772799c83c" ;;
  focal-arm64) package_checksum="d0188b4e65706f5143fcb000bb29e97d90a3848e7290c9155f7df20585957558" ;;
  jammy-amd64) package_checksum="485c190b1d9269fc40fc7205f850ecf71292d737cdb5482e778f2e52f128cd8a" ;;
  jammy-arm64) package_checksum="9b21779ee16e514bccd2971dcb3983cd8019a94c8614149dbd717d3702c8dbb5" ;;
  noble-amd64) package_checksum="f599fe02e2175b9817b6165f74a5d2bebdc73118dde9181ba3410963bed7ae1e" ;;
  noble-arm64) package_checksum="c9199cf4753208bfb69fd016a9780242bebfc43370cc38c97d61e90a3c783e04" ;;
  *) exit 2 ;;
esac

package_name="kasmvncserver_${codename}_${kasmvnc_version}_$architecture.deb"
cache=/var/cache/dbx-tools
package_file="$cache/$package_name"
temporary="$package_file.tmp.$$"
install -d -m 0755 "$cache"
if ! printf '%s  %s\n' "$package_checksum" "$package_file" |
  sha256sum --check --status 2>/dev/null; then
  PACKAGE_URL="https://github.com/kasmtech/KasmVNC/releases/download/v${kasmvnc_version}/$package_name" \
    PACKAGE_DESTINATION="$temporary" python3 - <<'PY'
import os
import urllib.request

request = urllib.request.Request(
    os.environ["PACKAGE_URL"],
    headers={"User-Agent": "dbx-tools-appkit-sandbox"},
)
with urllib.request.urlopen(request) as response:
    with open(os.environ["PACKAGE_DESTINATION"], "wb") as destination:
        while chunk := response.read(1024 * 1024):
            destination.write(chunk)
PY
  printf '%s  %s\n' "$package_checksum" "$temporary" | sha256sum --check --status
  mv -f -- "$temporary" "$package_file"
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  arc-theme ca-certificates dbus-daemon dbus-x11 epiphany-browser exo-utils \
  fonts-dejavu-core hicolor-icon-theme librsvg2-bin thunar \
  xfce4-whiskermenu-plugin x11-utils x11-xserver-utils xdg-utils xfce4-panel \
  xfce4-session xfce4-settings xfce4-terminal xfdesktop4 xfwm4 "$package_file"
