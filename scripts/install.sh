#!/usr/bin/env bash
set -euo pipefail

# Provides Node.js and npm, then delegates workspace setup to install.mjs.
#
# Standard output is reserved for shell exports so the installer can be
# consumed with eval. Progress and subprocess output are written to stderr.
#
# Usage:
#   ./scripts/install.sh
#   ./scripts/install.sh --dry-run
#   ./scripts/install.sh --dev-install --dry-run
#   DEV_INSTALL=1 DRY_RUN=1 ./scripts/install.sh
#   eval "$(./scripts/install.sh --dry-run)"
#
# Options:
#   --dev-install  Run the local install.mjs instead of downloading it.
#   --dry-run     Print caller shell updates without changing files.
#   --help        Print usage information.
#
# Environment:
#   DRY_RUN=1             Enable dry-run mode without a command-line option.
#   INSTALL_MISE=1        Install mise even when an existing command is found.
#   INSTALL_NODE=1        Install Node.js even when an existing command is found.
#   MISE_INSTALL_PATH     Mise binary path. Defaults to ~/.local/bin/mise.
#   MISE_VERSION          Optional mise version passed to the mise.run installer.
#   NODE_VERSION          Node.js version requested from mise. Defaults to lts.
#   NO_MODIFY_PATH=1      Do not add mise paths to shell profile files.
#   DEV_INSTALL=1         Run the local install.mjs for installer development.
#   DBX_TOOLS_REF         Git ref used for the remote install.mjs. Defaults to main.
#   INSTALL_MJS_URL       Full URL override for the remote install.mjs.
#
# Each function owns one setup concern so a future PowerShell installer can
# follow the same sequence without translating one large shell-specific block.

DRY_RUN="${DRY_RUN:-0}"
DEV_INSTALL="${DEV_INSTALL:-0}"
INSTALL_MISE="${INSTALL_MISE:-}"
INSTALL_NODE="${INSTALL_NODE:-}"
MISE_WAS_AVAILABLE=0
MISE_BIN_PATH_WAS_PRESENT=0
MISE_COMMAND=""
MISE_BIN_DIR=""
NODE_COMMAND=""
NODE_INSTALLER=""
NPM_COMMAND=""
SHELL_NAME="bash"

# Write a progress message to stderr.
log() {
  printf '[dbx-tools] %s\n' "$*" >&2
}

# Write an error and stop the installer.
fail() {
  log "error: $*"
  exit 1
}

# Print command usage to stderr without contaminating export output.
usage() {
  printf '%s\n' \
    "Usage: install.sh [--dev-install] [--dry-run] [--help]" \
    "" \
    "  --dev-install  Run the local scripts/install.mjs." \
    "  --dry-run     Print caller shell updates without changing files or tools." \
    "  --help        Print this help." >&2
}

# Replace the current home directory prefix with a portable $HOME reference.
portable_home_path() {
  local value="$1"

  if [[ "$value" == "$HOME" ]]; then
    printf '%s\n' '$HOME'
  elif [[ "$value" == "$HOME/"* ]]; then
    printf '$HOME/%s\n' "${value#"$HOME/"}"
  else
    printf '%s\n' "$value"
  fi
}

# Export a value and optionally print it for the consuming eval.
export_env() {
  local name="$1"
  local value="$2"
  local emit_eval="${3:-0}"
  local printable="$value"

  export "$name=$value"
  if [[ "$emit_eval" != "1" ]]; then
    return
  fi

  if [[ "$name" != "HOME" ]]; then
    printable="$(portable_home_path "$value")"
  fi

  if [[ "$printable" != "$value" ]]; then
    printf 'export %s="%s"\n' "$name" "$printable"
  else
    printf 'export %s=%q\n' "$name" "$value"
  fi
}

# Return success when PATH already contains a directory.
path_contains() {
  local directory="$1"

  case ":$PATH:" in
    *":$directory:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Prepend a missing directory to PATH and emit the updated export.
add_to_path() {
  local directory="$1"
  local printable

  if path_contains "$directory"; then
    log "PATH already contains $directory"
    return
  fi

  log "adding $directory to PATH"
  printable="$(portable_home_path "$directory")"
  export PATH="$directory:$PATH"
  printf 'export PATH="%s:$PATH"\n' "$printable"
}

# Add portable mise activation to one shell profile when it is missing.
append_profile_setup() {
  local profile="$1"
  local shell_name="$2"
  local marker="# >>> dbx-tools mise >>>"
  local profile_content

  mkdir -p "$(dirname "$profile")"
  touch "$profile"

  if grep -Fq "$marker" "$profile"; then
    log "profile already contains dbx-tools mise setup: $profile"
    return
  fi
  if grep -Eq "mise activate ${shell_name} .*--shims" "$profile"; then
    log "profile already activates mise shims: $profile"
    return
  fi

  if [[ "$MISE_BIN_PATH_WAS_PRESENT" -eq 0 ]]; then
    profile_content="$(printf '%s\n' \
      "$marker" \
      'case ":$PATH:" in' \
      '  *":$HOME/.local/bin:"*) ;;' \
      '  *) export PATH="$HOME/.local/bin:$PATH" ;;' \
      'esac' \
      "eval \"\$(mise activate $shell_name --shims)\"" \
      '# <<< dbx-tools mise <<<')"
  else
    profile_content="$(printf '%s\n' \
      "$marker" \
      "eval \"\$(mise activate $shell_name --shims)\"" \
      '# <<< dbx-tools mise <<<')"
  fi

  log "updating profile $profile"
  printf '\n%s\n' "$profile_content" >>"$profile"
  log "added the following to $profile:"
  printf '%s\n' "$profile_content" >&2
}

# Detect bash or zsh, falling back to bash for portable shim activation.
detect_shell() {
  local configured_shell="${SHELL:-}"
  local detected="${configured_shell##*/}"

  case "$detected" in
    bash | zsh)
      SHELL_NAME="$detected"
      ;;
    *)
      SHELL_NAME="bash"
      ;;
  esac
  log "detected shell $SHELL_NAME"
}

# Update the login and interactive profiles for the detected shell.
configure_shell_profiles() {
  case "$SHELL_NAME" in
    zsh)
      append_profile_setup "${ZDOTDIR:-$HOME}/.zprofile" zsh
      append_profile_setup "${ZDOTDIR:-$HOME}/.zshrc" zsh
      ;;
    *)
      append_profile_setup "$HOME/.bash_profile" bash
      append_profile_setup "$HOME/.bashrc" bash
      ;;
  esac
}

# Parse supported command-line options into installer state.
parse_arguments() {
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --dev-install)
        DEV_INSTALL=1
        ;;
      --dry-run)
        DRY_RUN=1
        ;;
      --help | -h)
        usage
        exit 0
        ;;
      *)
        fail "unsupported argument: $1"
        ;;
    esac
    shift
  done
}

# Resolve HOME only when the invoking environment did not provide it.
ensure_home() {
  local resolved_home

  if [[ -n "${HOME:-}" ]]; then
    log "using HOME=$HOME"
    return
  fi

  resolved_home="$(cd ~ 2>/dev/null && pwd -P)" ||
    fail "HOME is unset and could not be resolved"
  log "HOME was unset; resolved $resolved_home"
  export_env HOME "$resolved_home" 1
}

# Resolve and cache mise before this installer changes PATH.
detect_existing_mise() {
  MISE_COMMAND="$(command -v mise 2>/dev/null || true)"
  if [[ -z "$MISE_COMMAND" ]]; then
    log "mise not found"
    return
  fi
  if ! "$MISE_COMMAND" --version >/dev/null 2>&1; then
    log "mise found at $MISE_COMMAND but did not run successfully"
    MISE_COMMAND=""
    return
  fi

  MISE_WAS_AVAILABLE=1
  log "mise found at $MISE_COMMAND"
}

# Resolve and cache Node.js without changing the machine.
detect_existing_node() {
  NODE_COMMAND="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_COMMAND" ]]; then
    log "Node.js not found"
    return
  fi
  if ! "$NODE_COMMAND" --version >/dev/null 2>&1; then
    log "Node.js found at $NODE_COMMAND but did not run successfully"
    NODE_COMMAND=""
    return
  fi

  log "Node.js found at $NODE_COMMAND"
}

# Resolve and cache npm without changing the machine.
detect_existing_npm() {
  NPM_COMMAND="$(command -v npm 2>/dev/null || true)"
  if [[ -z "$NPM_COMMAND" ]]; then
    log "npm not found"
    return
  fi
  if ! "$NPM_COMMAND" --version >/dev/null 2>&1; then
    log "npm found at $NPM_COMMAND but did not run successfully"
    NPM_COMMAND=""
    return
  fi

  log "npm found at $NPM_COMMAND"
}

# Default unset installation controls from the detected command state.
resolve_install_controls() {
  if [[ -z "$INSTALL_MISE" ]]; then
    if [[ -z "$MISE_COMMAND" ]]; then
      INSTALL_MISE=1
    else
      INSTALL_MISE=0
    fi
  fi
  if [[ -z "$INSTALL_NODE" ]]; then
    if [[ -z "$NODE_COMMAND" ]]; then
      INSTALL_NODE=1
    else
      INSTALL_NODE=0
    fi
  fi

  case "$INSTALL_MISE" in
    0 | 1) ;;
    *) fail "INSTALL_MISE must be 0 or 1" ;;
  esac
  case "$INSTALL_NODE" in
    0 | 1) ;;
    *) fail "INSTALL_NODE must be 0 or 1" ;;
  esac

  log "install controls: mise=$INSTALL_MISE node=$INSTALL_NODE"
}

# Resolve and export the fixed mise binary and shim locations.
configure_mise_environment() {
  if [[ "$MISE_WAS_AVAILABLE" -eq 1 &&
    "$INSTALL_MISE" != "1" &&
    -z "${MISE_INSTALL_PATH:-}" ]]; then
    MISE_INSTALL_PATH="$MISE_COMMAND"
  else
    MISE_INSTALL_PATH="${MISE_INSTALL_PATH:-$HOME/.local/bin/mise}"
  fi

  MISE_BIN_DIR="$(dirname "$MISE_INSTALL_PATH")"
  log "mise install path: $MISE_INSTALL_PATH"

  if path_contains "$MISE_BIN_DIR"; then
    MISE_BIN_PATH_WAS_PRESENT=1
  fi

  export_env MISE_INSTALL_PATH "$MISE_INSTALL_PATH" 0
  add_to_path "$MISE_BIN_DIR"
}

# Download mise to the explicit MISE_INSTALL_PATH.
install_mise() {
  local installer_environment=(
    "MISE_INSTALL_PATH=$MISE_INSTALL_PATH"
    "MISE_QUIET=1"
  )

  command -v curl >/dev/null 2>&1 || fail "curl is required to install mise"
  mkdir -p "$MISE_BIN_DIR"

  if [[ -n "${MISE_VERSION:-}" ]]; then
    installer_environment+=("MISE_VERSION=$MISE_VERSION")
  fi

  log "installing mise to $MISE_INSTALL_PATH"
  curl -fsSL https://mise.run |
    env "${installer_environment[@]}" sh 1>&2
  hash -r
}

# Install mise when needed, then verify the command selected by PATH.
ensure_mise() {
  if [[ "$INSTALL_MISE" == "1" ]]; then
    log "mise installation required"
    install_mise
  else
    log "mise installation not needed"
  fi

  MISE_COMMAND="$(command -v mise 2>/dev/null || true)"
  if [[ -z "$MISE_COMMAND" ]] ||
    ! "$MISE_COMMAND" --version >/dev/null 2>&1; then
    fail "mise was installed but is not available"
  fi
  log "using $("$MISE_COMMAND" --version) at $MISE_COMMAND"
}

# Print the recommended mise shim activation when Node.js will use mise.
print_mise_activation() {
  if [[ "$INSTALL_NODE" != "1" ]]; then
    log "mise shim activation not needed for the existing Node.js installation"
    return
  fi

  printf 'eval "$(mise activate %s --shims)"\n' "$SHELL_NAME"
}

# Activate mise shims when Node.js will be installed through mise.
activate_mise_shims() {
  if [[ "$INSTALL_NODE" != "1" ]]; then
    log "mise shim activation not needed for the existing Node.js installation"
    return
  fi

  log "activating mise shims for $SHELL_NAME"
  eval "$("$MISE_COMMAND" activate "$SHELL_NAME" --shims)"
  print_mise_activation
}

# Persist mise paths only for a machine where mise was initially unavailable.
persist_new_mise_paths() {
  if [[ "$MISE_WAS_AVAILABLE" -eq 1 ]]; then
    log "profile update not needed because mise was already available"
    return
  fi
  if [[ "${NO_MODIFY_PATH:-0}" == "1" ]]; then
    log "profile update disabled by NO_MODIFY_PATH=1"
    return
  fi

  log "mise was newly installed; checking shell profiles"
  configure_shell_profiles
}

# Install the requested Node.js version through mise.
install_node() {
  local node_version="${NODE_VERSION:-lts}"

  log "installing node@$node_version with mise"
  "$MISE_COMMAND" use -g "node@$node_version" 1>&2
  hash -r
}

# Install Node.js when requested, then verify the selected command.
ensure_node() {
  if [[ "$INSTALL_NODE" == "1" ]]; then
    install_node
  else
    log "Node.js installation not needed"
  fi

  NODE_COMMAND="$(command -v node 2>/dev/null || true)"
  if [[ -z "$NODE_COMMAND" ]] ||
    ! "$NODE_COMMAND" --version >/dev/null 2>&1; then
    fail "Node.js is not available"
  fi
  log "using node $("$NODE_COMMAND" --version) at $NODE_COMMAND"
}

# Verify that the selected Node.js installation also provides npm.
ensure_npm() {
  NPM_COMMAND="$(command -v npm 2>/dev/null || true)"
  if [[ -z "$NPM_COMMAND" ]] ||
    ! "$NPM_COMMAND" --version >/dev/null 2>&1; then
    fail "npm was not installed with node"
  fi
  log "using npm $("$NPM_COMMAND" --version) at $NPM_COMMAND"
}

# Resolve and export the remote Node.js installer URL.
configure_node_installer_environment() {
  local ref="${DBX_TOOLS_REF:-main}"

  if [[ "$DEV_INSTALL" == "1" ]]; then
    log "development install mode selected"
    export_env DEV_INSTALL 1 0
    return
  fi

  INSTALL_MJS_URL="${INSTALL_MJS_URL:-https://raw.githubusercontent.com/reggie-db/dbx-tools/$ref/scripts/install.mjs}"
  log "remote install mode selected"
  log "remote Node.js installer: $INSTALL_MJS_URL"
  export_env INSTALL_MJS_URL "$INSTALL_MJS_URL" 0
}

# Locate install.mjs beside this script for DEV_INSTALL mode.
resolve_dev_node_installer() {
  local script_dir
  local script_source="${BASH_SOURCE[0]:-}"

  if [[ -n "$script_source" && -f "$script_source" ]]; then
    script_dir="$(cd "$(dirname "$script_source")" && pwd -P)"
    if [[ -f "$script_dir/install.mjs" ]]; then
      NODE_INSTALLER="$script_dir/install.mjs"
      return
    fi
  fi

  if [[ -f "$PWD/scripts/install.mjs" ]]; then
    NODE_INSTALLER="$PWD/scripts/install.mjs"
    return
  fi

  fail "DEV_INSTALL=1 requires a local scripts/install.mjs"
}

# Run the local development installer or stream the published installer.
launch_node_installer() {
  if [[ "$DEV_INSTALL" == "1" ]]; then
    resolve_dev_node_installer
    log "running local Node.js installer at $NODE_INSTALLER"
    exec node "$NODE_INSTALLER"
  fi

  command -v curl >/dev/null 2>&1 || fail "curl is required to download install.mjs"
  log "streaming Node.js installer from $INSTALL_MJS_URL"
  curl -fsSL "$INSTALL_MJS_URL" | node --input-type=module
}

# Run the platform bootstrap in an order shared by future platform ports.
main() {
  log "starting installer"
  parse_arguments "$@"
  log "options: dev_install=$DEV_INSTALL dry_run=$DRY_RUN"
  ensure_home
  detect_shell
  detect_existing_mise
  detect_existing_node
  detect_existing_npm
  resolve_install_controls
  configure_mise_environment
  configure_node_installer_environment

  if [[ "$DRY_RUN" == "1" ]]; then
    print_mise_activation
    log "skipping installation steps"
    log "dry run complete; no files or tools were changed"
    return
  fi

  ensure_mise
  activate_mise_shims
  persist_new_mise_paths
  ensure_node
  ensure_npm
  launch_node_installer
}

main "$@"
