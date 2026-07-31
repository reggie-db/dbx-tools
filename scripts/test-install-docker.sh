#!/usr/bin/env bash
set -euo pipefail

# Runs the installer from a read-only scripts-directory mount in clean Debian.
#
# A host npm registry is forwarded only when npm reports an HTTP registry on
# localhost or 127.0.0.1 with an explicit port.

log() {
  printf '[test-install] %s\n' "$*" >&2
}

host_platform() {
  local arch
  arch="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || true)"
  [[ -n "$arch" ]] && printf 'linux/%s\n' "$arch"
}

local_registry_url() {
  local registry
  registry="$(npm config get registry 2>/dev/null || true)"

  if [[ "$registry" =~ ^(https?://)(localhost|127\.0\.0\.1)(:[0-9]+)(/.*)?$ ]]; then
    printf '%sdocker.host%s%s\n' \
      "${BASH_REMATCH[1]}" \
      "${BASH_REMATCH[3]}" \
      "${BASH_REMATCH[4]:-}"
  fi
}

main() {
  local script_dir
  local registry_url=""
  local platform=""
  local docker_args=(
    run
    --rm
    -it
    --volume
    ""
    --workdir
    /workspace
    --env
    INSTALL_MJS_URL=file:///workspace/install.mjs
  )

  command -v docker >/dev/null 2>&1 || {
    log "docker is required"
    exit 1
  }

  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  docker_args[4]="$script_dir:/workspace:ro"

  # Pin the platform to the daemon's own architecture. Without it Docker reuses
  # whatever variant of the tag happens to be cached, and a cross-arch one runs
  # under QEMU - where esbuild's Go binary dies with a SIGSEGV on a non-canonical
  # fault address, killing tsx mid-transform. That surfaces 250 lines of Go panic
  # plus `Error: The service was stopped`, which reads like an installer bug and
  # is not one. `{{.Server.Arch}}` already yields Docker's own platform spelling
  # (`arm64`, `amd64`), so this stays correct on Apple Silicon, Intel, and CI.
  platform="$(host_platform)"
  if [[ -n "$platform" ]]; then
    log "running as $platform (matching the docker daemon)"
    docker_args+=(--platform "$platform")
  fi

  if command -v npm >/dev/null 2>&1; then
    registry_url="$(local_registry_url)"
  fi
  if [[ -n "$registry_url" ]]; then
    log "forwarding local npm registry as $registry_url"
    docker_args+=(
      --add-host=docker.host:host-gateway
      --env
      "npm_config_registry=$registry_url"
    )
  else
    log "using the container's default npm registry"
  fi

  docker "${docker_args[@]}" \
    debian:bookworm-slim \
    /bin/bash -lc '
      apt-get update && \
      apt-get install -y --no-install-recommends ca-certificates curl && \
      if INSTALL_CMD=$(/bin/bash install.sh); then
        eval "$INSTALL_CMD"
      else
        echo "Install script failed. Skipping eval." >&2
        exit 1
      fi
      /bin/bash
    '
}

main "$@"
