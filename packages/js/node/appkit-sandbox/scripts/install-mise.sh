#!/bin/sh
set -eu

mkdir -p "$HOME/.local/bin"
mise_bin="$HOME/.local/bin/mise"

if [ ! -x "$mise_bin" ]; then
  curl -fsSL https://mise.run | sh
fi

for file in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$file" ] || continue
  temporary="$file.dbx-tools.$$"
  awk '
    $0 == "# dbx-tools mise activation" { skip = 1; next }
    skip == 1 { skip = 0; next }
    { print }
  ' "$file" >"$temporary"
  mv -- "$temporary" "$file"
done

"$mise_bin" --version >/dev/null
