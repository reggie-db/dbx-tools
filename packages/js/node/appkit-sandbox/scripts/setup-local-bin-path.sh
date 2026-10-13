#!/bin/sh
set -eu

mkdir -p "$HOME/.local/bin"

append_once() {
  file="$1"
  marker="$2"
  content="$3"
  touch "$file"
  if ! grep -Fq "$marker" "$file"; then
    printf '\n%s\n' "$content" >>"$file"
  fi
}

path_block='# dbx-tools local bin path
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac'

for file in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  append_once "$file" '# dbx-tools local bin path' "$path_block"
done
