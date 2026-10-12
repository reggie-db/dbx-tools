#!/bin/sh
set -euf
umask 077

project_path="$1"
previous_path="$2"
toml_base64="$3"
projects_root="$HOME/projects"

validate_path() {
  candidate="$1"
  case "$candidate" in
    ""|/*|*\\*) return 1 ;;
  esac
  previous_ifs="$IFS"
  IFS=/
  set -- $candidate
  IFS="$previous_ifs"
  for segment in "$@"; do
    case "$segment" in
      ""|.|..) return 1 ;;
    esac
  done
}

validate_path "$project_path" || {
  printf 'Invalid project path: %s\n' "$project_path" >&2
  exit 2
}

mkdir -p "$projects_root"
project_directory="$projects_root/$project_path"

if [ -n "$previous_path" ] && [ "$previous_path" != "$project_path" ]; then
  validate_path "$previous_path" || {
    printf 'Invalid previous project path: %s\n' "$previous_path" >&2
    exit 2
  }
  previous_directory="$projects_root/$previous_path"
  if [ -d "$previous_directory" ] && [ ! -e "$project_directory" ]; then
    mkdir -p "$(dirname "$project_directory")"
    cp -a -- "$previous_directory" "$project_directory"
  fi
fi

mkdir -p "$project_directory"
temporary_file="$project_directory/.mise.toml.tmp.$$"
trap 'rm -f -- "$temporary_file"' EXIT HUP INT TERM
printf '%s' "$toml_base64" | base64 -d > "$temporary_file"
mv -- "$temporary_file" "$project_directory/mise.toml"
trap - EXIT HUP INT TERM

if [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
else
  mise_bin="$(command -v mise)"
fi

"$mise_bin" trust "$project_directory/mise.toml"
(
  cd "$project_directory"
  "$mise_bin" install
)

printf '__DBX_PROJECT_DIRECTORY__=%s\n' "$project_directory"
