#!/usr/bin/env bash
set -euo pipefail

# Bundle install.quickjs.ts once, then execute the same temporary ESM file in:
#
# 1. an official Node container, which must select the Node runtime adapter;
# 2. plain Debian with no Node/npm, which downloads the official quickjs-ng qjs
#    binary for the Docker daemon's architecture and selects the QuickJS adapter.

readonly QUICKJS_VERSION="${QUICKJS_VERSION:-0.15.1}"
TEMP_DIR=""

log() {
  printf '[test-install-quickjs] %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

host_platform() {
  local arch
  arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  [[ -n "$arch" ]] && printf 'linux/%s\n' "$arch"
}

main() {
  local platform=""
  local script_dir
  local -a docker_platform=()

  command -v docker >/dev/null 2>&1 || fail "docker is required"
  command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to run esbuild"

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  TEMP_DIR="$(mktemp -d "$script_dir/.quickjs-test.XXXXXX")"
  trap cleanup EXIT

  log "bundling install.quickjs.ts into $TEMP_DIR/install.quickjs.mjs"
  pnpm dlx esbuild "$script_dir/install.quickjs.ts" \
    --bundle \
    --format=esm \
    --platform=neutral \
    --target=es2022 \
    '--external:node:*' \
    '--external:qjs:*' \
    --outfile="$TEMP_DIR/install.quickjs.mjs"

  platform="$(host_platform)"
  if [[ -n "$platform" ]]; then
    log "using Docker daemon platform $platform"
    docker_platform=(--platform "$platform")
  fi

  log "testing Node runtime adapter"
  docker run \
    --rm \
    "${docker_platform[@]}" \
    --env INSTALL_RUNTIME_SMOKE=1 \
    --volume "$TEMP_DIR:/test:ro" \
    node:22-bookworm-slim \
    node /test/install.quickjs.mjs

  log "testing QuickJS runtime adapter from official v$QUICKJS_VERSION release"

  docker run \
    --rm \
    "${docker_platform[@]}" \
    --env INSTALL_RUNTIME_SMOKE=1 \
    --env "QUICKJS_VERSION=$QUICKJS_VERSION" \
    --volume "$TEMP_DIR:/test:ro" \
    debian:bookworm-slim \
    /bin/bash -euo pipefail -c '
      apt-get update
      apt-get install -y --no-install-recommends ca-certificates curl

      case "$(uname -m)" in
        x86_64) asset_arch=x86_64 ;;
        i386 | i686) asset_arch=x86 ;;
        aarch64 | arm64) asset_arch=aarch64 ;;
        armv7l) asset_arch=armv7 ;;
        riscv64) asset_arch=riscv64 ;;
        *) echo "Unsupported container architecture: $(uname -m)" >&2; exit 1 ;;
      esac

      curl -fsSL \
        "https://github.com/quickjs-ng/quickjs/releases/download/v${QUICKJS_VERSION}/qjs-linux-${asset_arch}" \
        -o /usr/local/bin/qjs
      chmod +x /usr/local/bin/qjs
      qjs --version
      qjs /test/install.quickjs.mjs
    '

  log "Node and QuickJS runtime adapters passed"
}

main "$@"
