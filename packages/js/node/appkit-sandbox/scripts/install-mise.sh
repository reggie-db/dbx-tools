#!/bin/sh
set -eu

mise_bin="$HOME/.local/bin/mise"

if [ ! -x "$mise_bin" ]; then
  curl -fsSL https://mise.run | sh
fi

mkdir -p "$HOME/.local/bin"

append_once() {
  file="$1"
  marker="$2"
  content="$3"
  touch "$file"
  if ! grep -Fq "$marker" "$file"; then
    printf '\n%s\n' "$content" >> "$file"
  fi
}

path_block='# dbx-tools mise path
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac'

append_once "$HOME/.profile" '# dbx-tools mise path' "$path_block"
append_once "$HOME/.bashrc" '# dbx-tools mise activation' "$path_block
# dbx-tools mise activation
eval "$("$HOME/.local/bin/mise" activate bash)""
append_once "$HOME/.zshrc" '# dbx-tools mise activation' "$path_block
# dbx-tools mise activation
eval "$("$HOME/.local/bin/mise" activate zsh)""

"$mise_bin" --version >/dev/null
