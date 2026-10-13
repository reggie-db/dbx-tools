#!/bin/sh
set -eu

maximum_log_lines="$1"
maximum_log_chars="$2"
if [ -x "$HOME/.local/bin/mise" ]; then
  mise_bin="$HOME/.local/bin/mise"
else
  mise_bin=$(command -v mise)
fi

for service_kind in terminal desktop stats; do
  operation_directory="$HOME/.dbx-tools/operations/services/$service_kind"
  service_directory="$HOME/projects/.sandbox-services/$service_kind"
  state=$(cat "$operation_directory/lifecycle.status" 2>/dev/null || true)
  if [ -d "$operation_directory/lifecycle.lock" ]; then
    state=starting
  fi
  if [ "$state" = ready ] &&
    { [ ! -d "$service_directory" ] ||
      ! (cd "$service_directory" && "$mise_bin" run status >/dev/null 2>&1); }; then
    state=stopped
    printf '%s\n' "$state" >"$operation_directory/lifecycle.status"
  fi
  case "$state" in
    starting|ready|error|stopped) ;;
    *) state=stopped ;;
  esac
  printf 'service\t%s\t%s\n' "$service_kind" "$state"
  if [ -f "$operation_directory/lifecycle.log" ]; then
    log_base64=$(tail -n "$maximum_log_lines" "$operation_directory/lifecycle.log" |
      tail -c "$maximum_log_chars" | base64 | tr -d '\n')
    printf 'service-log\t%s\t%s\n' "$service_kind" "$log_base64"
  fi
done

projects_root="$HOME/projects"
if [ -d "$projects_root" ]; then
  operations_root="$HOME/.dbx-tools/operations/projects"
  find "$operations_root" -type f -name lifecycle.status -print 2>/dev/null |
    while IFS= read -r status_file; do
      project_directory=${status_file%/lifecycle.status}
      case "$project_directory" in
        "$operations_root"/*) project_path=${project_directory#"$operations_root"/} ;;
        *) continue ;;
      esac
      state=$(cat "$status_file" 2>/dev/null || true)
      if [ -d "$project_directory/lifecycle.lock" ]; then
        state=starting
      fi
      case "$state" in
        starting|ready|error|stopped) ;;
        *) state=stopped ;;
      esac
      printf 'project\t%s\t%s\n' "$project_path" "$state"
    done
fi
