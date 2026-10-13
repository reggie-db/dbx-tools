#!/bin/sh
set -eu

cd "$HOME"
export HOMEBREW_NO_AUTO_UPDATE=1
brew_prefix=/home/linuxbrew/.linuxbrew
brew_bin="$brew_prefix/bin/brew"
marker='# dbx-tools homebrew shellenv'

if [ ! -x "$brew_bin" ]; then
  # The privileged bootstrap pre-creates a user-owned prefix so the official
  # installer can run without sudo.
  test -w "$brew_prefix"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
test -x "$brew_bin"

shellenv_block="$marker
if [ -x $brew_bin ]; then
  eval \"\$($brew_bin shellenv)\"
fi"

for file in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
  touch "$file"
  if ! grep -Fq "$marker" "$file"; then
    printf '\n%s\n' "$shellenv_block" >>"$file"
  fi
done

"$brew_bin" --version >/dev/null
