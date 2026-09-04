#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
OUT="$ROOT/crates/dbx-tools-u2m-node"
TARGET="$ROOT/target/release"
UBRN="$OUT/node_modules/.bin/ubrn"

case "$(uname -s)" in
  Darwin) LIBRARY="$TARGET/libdbx_tools_u2m_bindings.dylib" ;;
  Linux) LIBRARY="$TARGET/libdbx_tools_u2m_bindings.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIBRARY="$TARGET/dbx_tools_u2m_bindings.dll" ;;
  *) echo "unsupported build platform: $(uname -s)" >&2; exit 1 ;;
esac

cargo build --manifest-path "$ROOT/Cargo.toml" --release --package dbx-tools-u2m-bindings
rm -rf "$OUT/generated" "$OUT/dist"
mkdir -p "$OUT/generated" "$OUT/dist"
(
  cd "$ROOT"
  "$UBRN" generate napi bindings \
  --library \
  --ts-dir "$OUT/generated" \
  --lib-colocated \
  "$LIBRARY"
)
cp "$LIBRARY" "$OUT/generated/"
npx tsc --project "$OUT/tsconfig.json"
npx esbuild "$OUT/generated/index.ts" \
  --bundle \
  --external:@ubjs/core \
  --external:@ubjs/node \
  --format=esm \
  --outfile="$OUT/dist/index.js" \
  --platform=node \
  --target=node20
cp "$LIBRARY" "$OUT/dist/"
