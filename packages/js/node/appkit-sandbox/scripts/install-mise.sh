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
for file in "$HOME/.bashrc" "$HOME/.zshrc"; do
  if [ -f "$file" ]; then
    temporary="$file.dbx-tools.$$"
    awk '
      $0 == "# dbx-tools mise activation" { skip = 1; next }
      skip == 1 { skip = 0; next }
      { print }
    ' "$file" >"$temporary"
    mv -- "$temporary" "$file"
  fi
  append_once "$file" '# dbx-tools mise path' "$path_block"
done

"$mise_bin" --version >/dev/null
