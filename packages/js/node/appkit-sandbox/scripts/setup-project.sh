#!/bin/sh
set -euf
umask 077

project_path="$1"
previous_path="$2"
toml_base64="$3"
install_task="$4"
start_task="$5"
install_marker_path="$6"
start_marker_path="$7"
projects_root="$HOME/projects"

validate_path() {
  candidate="$1"
  case "$candidate" in
    ""|/*|*\\*) return 1 ;;
  esac
  previous_ifs="$IFS"
  IFS=/
  set -- $candidate
  IFS="$previous_ifs"
  for segment in "$@"; do
    case "$segment" in
      ""|.|..) return 1 ;;
    esac
  done
}

validate_path "$project_path" || {
  printf 'Invalid project path: %s\n' "$project_path" >&2
  exit 2
}
if [ -n "$previous_path" ]; then
  validate_path "$previous_path" || {
    printf 'Invalid previous project path: %s\n' "$previous_path" >&2
    exit 2
  }
fi

if [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
else
  mise_bin="$(command -v mise)"
fi

project_directory="$projects_root/$project_path"
operation_directory="$HOME/.dbx-tools/operations/projects/$project_path"
operation_lock="$operation_directory/lifecycle.lock"
operation_log="$operation_directory/lifecycle.log"
operation_status="$operation_directory/lifecycle.status"
operation_attempt="$operation_directory/lifecycle.attempt"
config_digest=$(printf '%s' "$toml_base64" | base64 -d | sha256sum | awk '{print $1}')
boot_id=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || printf unknown)
start_key="$boot_id:$config_digest"
operation_key="start:$start_key"
maximum_attempts=2
mkdir -p "$projects_root" "$operation_directory"

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

lifecycle_is_complete() {
  install_marker="$project_directory/$install_marker_path"
  start_marker="$project_directory/$start_marker_path"
  [ "$(cat "$install_marker" 2>/dev/null || true)" = "$config_digest" ] &&
    [ "$(cat "$start_marker" 2>/dev/null || true)" = "$start_key" ]
}

task_exists() {
  (cd "$project_directory" && "$mise_bin" tasks ls --name-only --hidden) | grep -Fxq "$1"
}

write_marker() {
  marker="$1"
  value="$2"
  temporary="$marker.tmp.$$"
  mkdir -p -- "$(dirname "$marker")"
  printf '%s\n' "$value" >"$temporary"
  mv -- "$temporary" "$marker"
}

record_result() {
  result="$1"
  printf '__DBX_TOOLS_RESULT__=%s attempt=%s\n' "$result" "$attempt_number" >>"$operation_log"
  printf '%s\n' "$result" >"$operation_status"
}

while ! lifecycle_is_complete; do
  acquire_operation_lock
  if lifecycle_is_complete; then
    release_operation_lock
    break
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

  if [ -n "$previous_path" ] && [ "$previous_path" != "$project_path" ]; then
    previous_directory="$projects_root/$previous_path"
    if [ -d "$previous_directory" ] && [ ! -e "$project_directory" ]; then
      mkdir -p "$(dirname "$project_directory")"
      cp -a -- "$previous_directory" "$project_directory"
    fi
  fi
  mkdir -p "$project_directory/.dbx-tools"
  temporary_file="$project_directory/.mise.toml.tmp.$$"
  if ! printf '%s' "$toml_base64" | base64 -d >"$temporary_file"; then
    rm -f -- "$temporary_file"
    record_result error
    release_operation_lock
    continue
  fi
  mv -- "$temporary_file" "$project_directory/mise.toml"
  install_marker="$project_directory/$install_marker_path"
  start_marker="$project_directory/$start_marker_path"

  if ! "$mise_bin" trust "$project_directory/mise.toml" >>"$operation_log" 2>&1 ||
    ! (cd "$project_directory" && "$mise_bin" install) >>"$operation_log" 2>&1; then
    record_result error
    release_operation_lock
    continue
  fi

  if [ "$(cat "$install_marker" 2>/dev/null || true)" != "$config_digest" ]; then
    if task_exists "$install_task" &&
      ! (cd "$project_directory" && "$mise_bin" run "$install_task") >>"$operation_log" 2>&1; then
      record_result error
      release_operation_lock
      continue
    fi
    write_marker "$install_marker" "$config_digest"
  fi

  if [ "$(cat "$start_marker" 2>/dev/null || true)" != "$start_key" ]; then
    if task_exists "$start_task" &&
      ! (cd "$project_directory" && "$mise_bin" run "$start_task") >>"$operation_log" 2>&1; then
      record_result error
      release_operation_lock
      continue
    fi
    write_marker "$start_marker" "$start_key"
  fi

  record_result ready
  release_operation_lock
done

printf '__DBX_PROJECT_DIRECTORY__=%s\n' "$project_directory"
