#!/bin/sh
set -euf
umask 077

service_kind="$1"
toml_base64="$2"
task="${3:-start}"
install="${4:-true}"

case "$service_kind" in
  terminal|desktop|stats) ;;
  *)
    printf 'Unknown packaged Sandbox service: %s\n' "$service_kind" >&2
    exit 2
    ;;
esac
case "$install" in
  true|false) ;;
  *)
    printf 'Invalid packaged Sandbox service install flag: %s\n' "$install" >&2
    exit 2
    ;;
esac
case "$task" in
  start|stop) ;;
  *)
    printf 'Unknown packaged Sandbox service task: %s\n' "$task" >&2
    exit 2
    ;;
esac

service_directory="$HOME/projects/.sandbox-services/$service_kind"
temporary_file="$service_directory/.mise.toml.tmp.$$"
mkdir -p "$service_directory"
trap 'rm -f -- "$temporary_file"' EXIT HUP INT TERM
printf '%s' "$toml_base64" | base64 -d >"$temporary_file"
mv -- "$temporary_file" "$service_directory/mise.toml"
trap - EXIT HUP INT TERM

if [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
else
  mise_bin="$(command -v mise)"
fi

"$mise_bin" trust "$service_directory/mise.toml"
(
  cd "$service_directory"
  if [ "$task" = start ] && [ "$install" = true ]; then
    "$mise_bin" install
  fi
  "$mise_bin" run "$task"
)
