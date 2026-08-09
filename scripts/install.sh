#!/usr/bin/env bash
set -euo pipefail

# Ensures Bun is available, then delegates setup to install.mjs.
#
# Bootstrap order:
#   1. Use an existing Bun.
#   2. Otherwise use an existing Node.js environment.
#   3. If both are absent, install Node.js 22 through NVM.
#   4. Prefer pnpm, falling back to npm, to install `bun` globally.
#
# Progress goes to stderr. stdout contains PATH exports suitable for eval.
#
# Environment:
#   NODE_VERSION      Node.js version requested from NVM. Defaults to 22.
#   NVM_DIR           NVM install directory. Defaults to ~/.nvm.
#   BUN_VERSION       Bun npm version. Defaults to latest.
#   DEV_INSTALL=1     Run the local scripts/install.mjs.
#   DRY_RUN=1         Print PATH exports without changing files.
#   DBX_TOOLS_REF     Git ref for remote install.mjs. Defaults to main.
#   INSTALL_MJS_URL   Full URL override for remote install.mjs.

DEV_INSTALL="${DEV_INSTALL:-0}"
DRY_RUN="${DRY_RUN:-0}"
BUN_COMMAND=""
NODE_COMMAND=""
NPM_COMMAND=""
PNPM_COMMAND=""
NODE_INSTALLED=0

log() {
  printf '[dbx-tools] %s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage: install.sh [--dev-install] [--dry-run] [--help]

  --dev-install  Run the local scripts/install.mjs.
  --dry-run      Print PATH exports without changing files.
  --help         Print this help.
USAGE
}

parse_arguments() {
  while (($#)); do
    case "$1" in
      --dev-install) DEV_INSTALL=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --help | -h)
        usage
        exit 0
        ;;
      *) fail "unsupported argument: $1" ;;
    esac
    shift
  done
}

configure_nvm() {
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR
}

command_path() {
  local name="$1"
  command -v "$name" 2>/dev/null || true
}

working_command() {
  local command="$1"
  [[ -n "$command" ]] && "$command" --version >/dev/null 2>&1
}

detect_tools() {
  BUN_COMMAND="$(command_path bun)"
  NODE_COMMAND="$(command_path node)"
  NPM_COMMAND="$(command_path npm)"
  PNPM_COMMAND="$(command_path pnpm)"

  working_command "$BUN_COMMAND" || BUN_COMMAND=""
  working_command "$NODE_COMMAND" || NODE_COMMAND=""
  working_command "$NPM_COMMAND" || NPM_COMMAND=""
  working_command "$PNPM_COMMAND" || PNPM_COMMAND=""

  working_command "$BUN_COMMAND" || BUN_COMMAND=""
  working_command "$NODE_COMMAND" || NODE_COMMAND=""
  working_command "$NPM_COMMAND" || NPM_COMMAND=""
}

install_node() {
  local version="${NODE_VERSION:-22}" profile
  command -v curl >/dev/null 2>&1 || fail "curl is required to download Node.js"
  case "${SHELL##*/}" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    *) profile="$HOME/.bashrc" ;;
  esac
  mkdir -p "$(dirname "$profile")"
  touch "$profile"
  log "installing NVM and Node.js $version"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE="$profile" bash >&2
  # NVM's installer owns persistent shell-profile setup; source it here because
  # the current non-interactive shell cannot observe that profile update yet.
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install "$version" >&2
  nvm alias default "$version" >&2
  nvm use "$version" >&2
  NODE_COMMAND="$(command_path node)"
  NPM_COMMAND="$(command_path npm)"
  NODE_INSTALLED=1
}

ensure_node_environment() {
  if [[ -n "$NODE_COMMAND" && (-n "$PNPM_COMMAND" || -n "$NPM_COMMAND") ]]; then
    export PATH="$(dirname "$NODE_COMMAND"):$PATH"
    return
  fi
  install_node
}

npm_registry() {
  if [[ -n "${npm_config_registry:-}" ]]; then
    printf '%s\n' "$npm_config_registry"
  elif [[ -n "${NPM_CONFIG_REGISTRY:-}" ]]; then
    printf '%s\n' "$NPM_CONFIG_REGISTRY"
  elif [[ -n "$NPM_COMMAND" ]]; then
    "$NPM_COMMAND" config get registry 2>/dev/null || true
  fi
}

install_bun() {
  local package="bun${BUN_VERSION:+@$BUN_VERSION}" registry
  registry="$(npm_registry)"

  if [[ -n "$PNPM_COMMAND" ]]; then
    log "installing $package globally with pnpm"
    local pnpm_args=(add --global "$package")
    [[ -z "$registry" ]] || pnpm_args+=(--registry "$registry")
    if "$PNPM_COMMAND" "${pnpm_args[@]}" >&2; then
      BUN_COMMAND="$(command_path bun)"
      if working_command "$BUN_COMMAND"; then
        return
      fi
      log "pnpm completed without exposing Bun on PATH; falling back to npm"
    else
      log "pnpm global install failed; falling back to npm"
    fi
  fi

  [[ -n "$NPM_COMMAND" ]] || fail "npm is unavailable"
  log "installing $package globally with npm"
  local npm_args=(install --global "$package")
  [[ -z "$registry" ]] || npm_args+=(--registry "$registry")
  "$NPM_COMMAND" "${npm_args[@]}" >&2
}

ensure_bun() {
  if [[ -n "$BUN_COMMAND" ]] && "$BUN_COMMAND" --version >/dev/null 2>&1; then
    log "using Bun $($BUN_COMMAND --version) at $BUN_COMMAND"
    return
  fi

  ensure_node_environment
  install_bun
  BUN_COMMAND="$(command_path bun)"
  working_command "$BUN_COMMAND" || fail "Bun installed without exposing a working executable"
  log "using Bun $($BUN_COMMAND --version) at $BUN_COMMAND"
}

emit_path() {
  local bin_dir
  bin_dir="$(dirname "$BUN_COMMAND")"
  export PATH="$bin_dir:$PATH"
  printf 'export PATH=%q:"$PATH"\n' "$bin_dir"
  if [[ "$NODE_INSTALLED" == "1" ]]; then
    printf 'export NVM_DIR=%q\n' "$NVM_DIR"
    printf '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"\n'
  fi
}

resolve_local_installer() {
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  [[ -f "$script_dir/install.mjs" ]] || fail "missing $script_dir/install.mjs"
  printf '%s\n' "$script_dir/install.mjs"
}

run_installer() {
  if [[ "$DEV_INSTALL" == "1" ]]; then
    export DEV_INSTALL=1
    "$BUN_COMMAND" run "$(resolve_local_installer)"
    return
  fi

  local ref="${DBX_TOOLS_REF:-main}"
  local url="${INSTALL_MJS_URL:-https://raw.githubusercontent.com/reggie-db/dbx-tools/$ref/scripts/install.mjs}"
  command -v curl >/dev/null 2>&1 || fail "curl is required to download install.mjs"
  log "running installer from $url"
  curl -fsSL "$url" | "$BUN_COMMAND" run -
}

main() {
  parse_arguments "$@"
  configure_nvm
  detect_tools

  if [[ "$DRY_RUN" == "1" ]]; then
    if [[ -n "$BUN_COMMAND" ]]; then
      printf 'export PATH=%q:"$PATH"\n' "$(dirname "$BUN_COMMAND")"
    else
      printf 'export NVM_DIR=%q\n' "$NVM_DIR"
      printf '[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"\n'
    fi
    log "dry run complete"
    return
  fi

  ensure_bun
  emit_path
  run_installer
}

main "$@"
