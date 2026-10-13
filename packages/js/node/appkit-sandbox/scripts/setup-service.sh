#!/bin/sh
set -euf
umask 077

service_kind="$1"
toml_base64="$2"
task="${3:-start}"
install="${4:-true}"

case "$service_kind" in
  terminal|desktop|stats) ;;
  *)
    printf 'Unknown packaged Sandbox service: %s\n' "$service_kind" >&2
    exit 2
    ;;
esac
case "$install" in
  true|false) ;;
  *)
    printf 'Invalid packaged Sandbox service install flag: %s\n' "$install" >&2
    exit 2
    ;;
esac
case "$task" in
  start|stop) ;;
  *)
    printf 'Unknown packaged Sandbox service task: %s\n' "$task" >&2
    exit 2
    ;;
esac

if [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
else
  mise_bin="$(command -v mise)"
fi

service_directory="$HOME/projects/.sandbox-services/$service_kind"
operation_directory="$HOME/.dbx-tools/operations/services/$service_kind"
operation_lock="$operation_directory/lifecycle.lock"
operation_log="$operation_directory/lifecycle.log"
operation_status="$operation_directory/lifecycle.status"
operation_attempt="$operation_directory/lifecycle.attempt"
config_digest=$(printf '%s' "$toml_base64" | base64 -d | sha256sum | awk '{print $1}')
runner_version=2
operation_key="$runner_version:$task:$install:$config_digest"
maximum_attempts=2
mkdir -p "$operation_directory"

release_operation_lock() {
  trap - EXIT HUP INT TERM
  rm -rf -- "$operation_lock"
}

acquire_operation_lock() {
  while ! mkdir "$operation_lock" 2>/dev/null; do
    lock_pid=$(cat "$operation_lock/pid" 2>/dev/null || true)
    case "$lock_pid" in
      ''|*[!0-9]*)
        if find "$operation_lock" -prune -mmin +1 -print 2>/dev/null | grep -q .; then
          rm -rf -- "$operation_lock"
          continue
        fi
        ;;
      *)
        if ! kill -0 "$lock_pid" 2>/dev/null; then
          rm -rf -- "$operation_lock"
          continue
        fi
        ;;
    esac
    sleep 0.2
  done
  printf '%s\n' "$$" >"$operation_lock/pid"
  trap release_operation_lock EXIT HUP INT TERM
}

service_is_complete() {
  state=$(cat "$operation_status" 2>/dev/null || true)
  if [ "$task" = stop ]; then
    [ "$state" = stopped ]
    return
  fi
  [ "$state" = ready ] || return 1
  [ "$install" = false ] ||
    [ "$(cat "$service_directory/.dbx-tools-install.sha256" 2>/dev/null || true)" = "$config_digest" ]
}

record_result() {
  result="$1"
  printf '__DBX_TOOLS_RESULT__=%s attempt=%s\n' "$result" "$attempt_number" >>"$operation_log"
  printf '%s\n' "$result" >"$operation_status"
}

while :; do
  if service_is_complete; then
    exit 0
  fi

  acquire_operation_lock
  if service_is_complete; then
    release_operation_lock
    exit 0
  fi

  attempt_key=$(awk 'NR == 1 { print; exit }' "$operation_attempt" 2>/dev/null || true)
  attempt_count=$(awk 'NR == 2 { print; exit }' "$operation_attempt" 2>/dev/null || true)
  case "$attempt_count" in
    ''|*[!0-9]*) attempt_count=0 ;;
  esac
  if [ "$attempt_key" != "$operation_key" ]; then
    attempt_count=0
  fi
  if [ "$attempt_count" -ge "$maximum_attempts" ]; then
    cat "$operation_log" >&2 2>/dev/null || true
    release_operation_lock
    exit 1
  fi

  attempt_number=$((attempt_count + 1))
  printf '%s\n%s\n' "$operation_key" "$attempt_number" >"$operation_attempt"
  : >"$operation_log"
  printf '__DBX_TOOLS_ATTEMPT__=%s\n' "$attempt_number" >>"$operation_log"
  printf 'starting\n' >"$operation_status"

  mkdir -p "$service_directory"
  temporary_file="$service_directory/.mise.toml.tmp.$$"
  if ! printf '%s' "$toml_base64" | base64 -d >"$temporary_file"; then
    rm -f -- "$temporary_file"
    record_result error
    rm -rf -- "$service_directory"
    release_operation_lock
    continue
  fi
  mv -- "$temporary_file" "$service_directory/mise.toml"

  if ! "$mise_bin" trust "$service_directory/mise.toml" >>"$operation_log" 2>&1; then
    record_result error
    rm -rf -- "$service_directory"
    release_operation_lock
    continue
  fi

  install_marker="$service_directory/.dbx-tools-install.sha256"
  if [ "$task" = start ] && [ "$install" = true ]; then
    if ! (cd "$service_directory" && "$mise_bin" install) >>"$operation_log" 2>&1; then
      record_result error
      rm -rf -- "$service_directory"
      release_operation_lock
      continue
    fi
    marker_temporary="$install_marker.tmp.$$"
    printf '%s\n' "$config_digest" >"$marker_temporary"
    mv -- "$marker_temporary" "$install_marker"
  fi

  if ! (cd "$service_directory" && "$mise_bin" run "$task") >>"$operation_log" 2>&1; then
    rm -f -- "$install_marker"
    record_result error
    release_operation_lock
    continue
  fi

  if [ "$task" = start ]; then
    record_result ready
  else
    record_result stopped
  fi
  release_operation_lock
  exit 0
done
