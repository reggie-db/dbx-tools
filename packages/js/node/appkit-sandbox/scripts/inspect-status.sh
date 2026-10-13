#!/bin/sh
set -eu

for service_kind in terminal desktop stats; do
  operation_directory="$HOME/.dbx-tools/operations/services/$service_kind"
  state=$(cat "$operation_directory/lifecycle.status" 2>/dev/null || true)
  if [ -d "$operation_directory/lifecycle.lock" ]; then
    state=starting
  fi
  case "$state" in
    starting|ready|error|stopped) ;;
    *) state=stopped ;;
  esac
  printf 'service\t%s\t%s\n' "$service_kind" "$state"
  if [ -f "$operation_directory/lifecycle.log" ]; then
    log_base64=$(base64 <"$operation_directory/lifecycle.log" | tr -d '\n')
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
