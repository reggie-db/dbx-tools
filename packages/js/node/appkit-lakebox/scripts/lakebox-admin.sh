#!/bin/sh
# Package-owned privileged Lakebox administration. Runs as root through the
# fixed bootstrap capability only; never receives REST, agent, or service input
# other than the validated hash, UID, digest, and port arguments below.
set -eu
umask 022

agent_home=/home/sandbox-agent
state=$agent_home/.dbx-tools
users=$state/users
identities=$state/identities
runtime=$state/runtime
bundle=$runtime/container-v1
run_root=/run/lakebox
port_min=20000
port_max=31999
agent_uid=$(id -u sandbox-agent)

valid_hash() {
  case "$1" in
    ''|*[!0-9a-v]*) return 1 ;;
  esac
  [ "${#1}" -eq 7 ]
}

valid_number() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
}

with_lock() {
  install -d -m 0755 "$run_root"
  exec 9>"$run_root/admin.lock"
  flock 9
}

ensure_layout() {
  chmod 0711 "$agent_home"
  install -d -m 0711 -o root -g root "$state" "$users" "$runtime"
  install -d -m 0700 -o root -g root "$identities"
  install -d -m 0755 -o root -g root "$run_root" "$runtime/bin"
}

ensure_bundle() {
  if [ -x "$bundle/root/usr/bin/buildah" ] && [ -x "$bundle/root/usr/bin/crun" ] &&
    [ -f "$bundle/complete" ]; then
    return 0
  fi
  echo "installing container runtime bundle"
  debs=$(mktemp -d)
  rm -rf "$bundle.tmp"
  install -d -m 0755 "$bundle.tmp/root"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -qq -o Dir::Cache::archives="$debs" \
    -o APT::Keep-Downloaded-Packages=true --download-only install -y \
    --no-install-recommends buildah crun uidmap >/dev/null
  for deb in "$debs"/*.deb; do dpkg-deb -x "$deb" "$bundle.tmp/root"; done
  rm -rf "$debs"
  chmod -R a+rX "$bundle.tmp"
  touch "$bundle.tmp/complete"
  rm -rf "$bundle"
  mv "$bundle.tmp" "$bundle"
}

ensure_ttyd() {
  version=1.7.7
  case "$(uname -m)" in
    aarch64) checksum=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165 ;;
    x86_64) checksum=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55 ;;
    *) echo "unsupported ttyd architecture $(uname -m)" >&2; return 1 ;;
  esac
  target=$runtime/bin/ttyd
  if [ -x "$target" ] && printf '%s  %s\n' "$checksum" "$target" | sha256sum --check --status; then
    return 0
  fi
  echo "installing ttyd $version"
  curl -fsSL -o "$target.tmp" \
    "https://github.com/tsl0922/ttyd/releases/download/$version/ttyd.$(uname -m)"
  printf '%s  %s\n' "$checksum" "$target.tmp" | sha256sum --check --status
  chmod 0755 "$target.tmp"
  mv -f "$target.tmp" "$target"
}

# Installs one package-owned helper delivered as base64 when its content changed.
install_helper() {
  name=$1
  case "$name" in
    lakebox-service|desktop-session|desktop-prerequisites) ;;
    *) echo "unknown helper $name" >&2; return 2 ;;
  esac
  target=$runtime/bin/$name
  temporary=$target.tmp.$$
  printf %s "$2" | base64 -d >"$temporary"
  if [ -f "$target" ] && cmp -s "$temporary" "$target"; then
    rm -f "$temporary"
    return 0
  fi
  chmod 0755 "$temporary"
  mv -f "$temporary" "$target"
}

ensure_firewall() {
  if nft list table inet lakebox >/dev/null 2>&1; then return 0; fi
  nft -f - <<NFT
table inet lakebox {
  set allowed {
    typeof meta skuid . tcp dport
  }
  chain output {
    type filter hook output priority 0; policy accept;
    oifname "lo" tcp dport $port_min-$port_max meta skuid { 0, $agent_uid } accept
    oifname "lo" tcp dport $port_min-$port_max meta skuid . tcp dport @allowed accept
    oifname "lo" tcp dport $port_min-$port_max drop
  }
}
NFT
}

# Recreates one account whose persistent home already exists. The UID is read
# from the persistent directory so file ownership survives every restart.
restore_account() {
  hash=$1
  persist=$users/$hash
  name=lakebox-$hash
  uid=$(stat -c %u "$persist")
  existing=$(getent passwd "$uid" | cut -d: -f1 || true)
  if [ -n "$existing" ] && [ "$existing" != "$name" ]; then
    echo "UID $uid for $name is already used by $existing" >&2
    return 1
  fi
  if ! getent group "$name" >/dev/null; then groupadd --gid "$uid" "$name"; fi
  if ! getent passwd "$name" >/dev/null; then
    useradd --uid "$uid" --gid "$uid" --no-create-home --home-dir "/home/$name" \
      --shell /bin/bash "$name" 2>/dev/null
  fi
  passwd --lock "$name" >/dev/null 2>&1 || true
  ln -sfn "$persist" "/home/$name"
  install -d -m 0700 -o "$uid" -g "$uid" "$run_root/$hash"
  for definition in "$persist"/.dbx-tools/services/*/service.json; do
    [ -f "$definition" ] || continue
    port=$(python3 -c 'import json, sys; print(int(json.load(open(sys.argv[1]))["port"]))' "$definition") || continue
    allow_port "$uid" "$port"
  done
}

allow_port() {
  valid_number "$1" && valid_number "$2" || { echo "invalid port arguments" >&2; return 2; }
  [ "$2" -ge "$port_min" ] && [ "$2" -le "$port_max" ] || {
    echo "port $2 is outside the Lakebox service range" >&2
    return 2
  }
  ensure_firewall
  nft add element inet lakebox allowed "{ $1 . $2 }"
}

command=${1:-}
case "$command" in
  bootstrap)
    shift
    with_lock
    ensure_layout
    for helper in "$@"; do
      install_helper "${helper%%=*}" "${helper#*=}"
    done
    ensure_bundle
    ensure_ttyd
    ensure_firewall
    for persist in "$users"/*; do
      [ -d "$persist" ] || continue
      hash=$(basename "$persist")
      valid_hash "$hash" || continue
      if restore_account "$hash"; then
        echo "__LAKEBOX_USER__=$hash"
      else
        echo "skipped $hash" >&2
      fi
    done
    echo "__LAKEBOX_BOOTSTRAP__=ready"
    ;;
  ensure-user)
    hash=${2:-}
    uid=${3:-}
    digest=${4:-}
    valid_hash "$hash" && valid_number "$uid" || { echo "invalid user arguments" >&2; exit 2; }
    case "$digest" in ''|*[!0-9a-f]*) echo "invalid identity digest" >&2; exit 2 ;; esac
    with_lock
    ensure_layout
    marker=$identities/$hash
    if [ -f "$marker" ] && [ "$(cat "$marker")" != "$digest" ]; then
      echo "Lakebox user hash $hash collides with another identity" >&2
      exit 3
    fi
    persist=$users/$hash
    if [ -d "$persist" ]; then
      owner=$(stat -c %u "$persist")
      if [ "$owner" != "$uid" ]; then
        echo "Lakebox user $hash home is owned by UID $owner, expected $uid" >&2
        exit 3
      fi
    else
      existing=$(getent passwd "$uid" | cut -d: -f1 || true)
      if [ -n "$existing" ] && [ "$existing" != "lakebox-$hash" ]; then
        echo "Derived UID $uid for lakebox-$hash is already used by $existing" >&2
        exit 3
      fi
      install -d -m 0700 -o "$uid" -g "$uid" "$persist"
    fi
    printf '%s\n' "$digest" >"$marker"
    chmod 0600 "$marker"
    restore_account "$hash"
    ;;
  allow-port)
    allow_port "${2:-}" "${3:-}"
    ;;
  desktop-prerequisites)
    with_lock
    sh "$runtime/bin/desktop-prerequisites"
    ;;
  metrics)
    # Machine-level counters only; never reads process tables.
    printf 'cores %s\n' "$(nproc)"
    head -n 1 /proc/stat
    awk '{ print "load", $1 }' /proc/loadavg
    awk '/^MemTotal:|^MemAvailable:/ { print $1, $2 }' /proc/meminfo
    df -B1 --output=size,used "$agent_home" | awk 'NR == 2 { print "storage", $1, $2 }'
    awk -F'[: ]+' 'NR > 2 && $2 != "lo" { rx += $3; tx += $11 }
      END { print "network", rx + 0, tx + 0 }' /proc/net/dev
    ;;
  *)
    echo "usage: lakebox-admin bootstrap [name=base64...]|ensure-user|allow-port|desktop-prerequisites|metrics" >&2
    exit 2
    ;;
esac
