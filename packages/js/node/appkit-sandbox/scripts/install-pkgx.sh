#!/bin/sh
set -eu

mkdir -p "$HOME/.local/bin"
pkgx_bin="$HOME/.local/bin/pkgx"

if [ ! -x "$pkgx_bin" ]; then
  temporary="$pkgx_bin.tmp.$$"
  curl -o "$temporary" --compressed --fail --proto '=https' \
    "https://pkgx.sh/$(uname)/$(uname -m)"
  chmod 0755 "$temporary"
  mv -f -- "$temporary" "$pkgx_bin"
fi
test -x "$pkgx_bin"
