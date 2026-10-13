#!/bin/sh
set -eu

user=sandbox-user
group=sandbox-user
home=/home/sandbox-user
state=/var/lib/dbx-tools/sandbox-user-v2
lock=/var/lock/dbx-tools-sandbox-user.lock
sudoers=/etc/sudoers.d/zz-dbx-tools-sandbox-user

is_ready() {
  [ -f "$state" ] || return 1
  command -v pkgx >/dev/null 2>&1 || return 1
  [ -f "$sudoers" ] || return 1
  [ ! -d /root ] || [ "$(stat -c %a /root)" = 700 ] || return 1
  entry=$(getent passwd "$user" 2>/dev/null || true)
  [ -n "$entry" ] || return 1
  [ "$(printf '%s' "$entry" | cut -d: -f6)" = "$home" ] || return 1
  [ "$(printf '%s' "$entry" | cut -d: -f7)" = /bin/bash ]
}

if is_ready; then
  exit 0
fi

while ! mkdir "$lock" 2>/dev/null; do
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  case "$owner" in
    ''|*[!0-9]*)
      rm -rf -- "$lock"
      ;;
    *)
      if ! kill -0 "$owner" 2>/dev/null; then
        rm -rf -- "$lock"
      else
        sleep 0.2
      fi
      ;;
  esac
done
printf '%s\n' "$$" >"$lock/pid"
trap 'rm -rf -- "$lock"' EXIT HUP INT TERM

if is_ready; then
  exit 0
fi

if ! command -v pkgx >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl
  fi
  curl -fsS https://pkgx.sh | sh
fi
command -v pkgx >/dev/null 2>&1

if id "$user" >/dev/null 2>&1; then
  entry=$(getent passwd "$user")
  [ "$(printf '%s' "$entry" | cut -d: -f6)" = "$home" ]
  [ "$(printf '%s' "$entry" | cut -d: -f7)" = /bin/bash ]
else
  useradd --create-home --home-dir "$home" --shell /bin/bash --user-group "$user"
fi
passwd --lock "$user" >/dev/null 2>&1 || true
for privileged_group in sudo wheel admin; do
  if getent group "$privileged_group" >/dev/null 2>&1; then
    gpasswd --delete "$user" "$privileged_group" >/dev/null 2>&1 || true
  fi
done
temporary_sudoers="$sudoers.tmp.$$"
printf '%s\n' "$user ALL=(ALL:ALL) !ALL" >"$temporary_sudoers"
chmod 0440 "$temporary_sudoers"
visudo -cf "$temporary_sudoers" >/dev/null
mv -f -- "$temporary_sudoers" "$sudoers"
[ ! -d /root ] || chmod 0700 /root

install -d -m 0750 -o "$user" -g "$group" "$home"
for directory in \
  "$home/projects" \
  "$home/.dbx-tools" \
  "$home/.dbx-tools/operations" \
  "$home/.dbx-tools/runtime" \
  "$home/.local" \
  "$home/.local/bin" \
  "$home/.config"; do
  install -d -m 0750 -o "$user" -g "$group" "$directory"
done

migrate_directory() {
  source=$1
  destination=$2
  [ -d "$source" ] || return 0
  if find "$source" -type l -print -quit | grep -q .; then
    return 0
  fi
  if find "$source" ! -type f ! -type d -print -quit | grep -q .; then
    return 0
  fi
  install -d -m 0750 -o "$user" -g "$group" "$destination"
  cp -a "$source/." "$destination/"
  chown -R --no-dereference "$user:$group" "$destination"
}

legacy=/home/sandbox-agent
migrate_directory "$legacy/projects" "$home/projects"
migrate_directory "$legacy/.dbx-tools" "$home/.dbx-tools"
migrate_directory "$legacy/.local" "$home/.local"
migrate_directory "$legacy/.config" "$home/.config"
find "$home/.dbx-tools" -type f -name '*.pid' -delete
find "$home/.dbx-tools/operations" -type d -name lifecycle.lock -prune -exec rm -rf -- {} +

install -d -m 0755 "$(dirname "$state")"
temporary="$state.tmp.$$"
printf '%s\n' 1 >"$temporary"
chmod 0644 "$temporary"
mv -f -- "$temporary" "$state"
