#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
OUT="$ROOT/crates/dbx-tools-u2m-python"
TARGET="$ROOT/target/release"

case "$(uname -s)" in
  Darwin) LIBRARY="$TARGET/libdbx_tools_u2m_bindings.dylib" ;;
  Linux) LIBRARY="$TARGET/libdbx_tools_u2m_bindings.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIBRARY="$TARGET/dbx_tools_u2m_bindings.dll" ;;
  *) echo "unsupported build platform: $(uname -s)" >&2; exit 1 ;;
esac

cargo build --manifest-path "$ROOT/Cargo.toml" --release --package dbx-tools-u2m-bindings
rm -rf "$OUT/generated" "$OUT/build" "$OUT/dist"
mkdir -p "$OUT/generated"
cd "$ROOT"
cargo run --package dbx-tools-u2m-bindings --bin uniffi-bindgen -- \
  generate --language python --out-dir "$OUT/generated" \
  "$LIBRARY"
mkdir -p "$OUT/generated/dbx_tools_u2m_bindings"
mv "$OUT/generated/dbx_tools_u2m_bindings.py" \
  "$OUT/generated/dbx_tools_u2m_bindings/__init__.py"
cp "$LIBRARY" "$OUT/generated/dbx_tools_u2m_bindings/"
uvx --from build python -m build --wheel "$OUT"
