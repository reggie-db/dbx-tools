#!/bin/sh
set -euf

project_path="$1"
uninstall_task="$2"
case "$project_path" in
  ""|/*|*\\*)
    printf 'Invalid project path: %s\n' "$project_path" >&2
    exit 2
    ;;
esac

previous_ifs="$IFS"
IFS=/
set -- $project_path
IFS="$previous_ifs"
for segment in "$@"; do
  case "$segment" in
    ""|.|..)
      printf 'Invalid project path: %s\n' "$project_path" >&2
      exit 2
      ;;
  esac
done

list_proc_dirs() {
  (
    set +f
    for proc in /proc/[0-9]*; do
      [ -d "$proc" ] || continue
      printf '%s\n' "$proc"
    done
  )
}

kill_tree() {
  pid="$1"
  case "$pid" in
    ''|*[!0-9]*) return 0 ;;
  esac
  if [ "$pid" = "$$" ] || [ "$pid" = "$PPID" ]; then
    return 0
  fi
  list_proc_dirs | while IFS= read -r proc; do
    ppid=$(awk '/^PPid:/{print $2; exit}' "$proc/status" 2>/dev/null || true)
    if [ "$ppid" = "$pid" ]; then
      kill_tree "${proc##*/}"
    fi
  done
  kill "$pid" 2>/dev/null || true
}

project_pids() {
  dir="$1"
  find "$dir" -maxdepth 1 -type f -name '*.pid' 2>/dev/null | while IFS= read -r pidfile; do
    tr -d ' \n' < "$pidfile"
    printf '\n'
  done
  list_proc_dirs | while IFS= read -r proc; do
    pid="${proc##*/}"
    [ "$pid" = "$$" ] && continue
    cwd=$(readlink "$proc/cwd" 2>/dev/null || true)
    case "$cwd" in
      "$dir"|"$dir (deleted)") printf '%s\n' "$pid" ;;
    esac
  done
}

stop_project_processes() {
  dir="$1"
  pids=$(project_pids "$dir" || true)
  [ -n "${pids:-}" ] || return 0
  for pid in $pids; do
    kill_tree "$pid"
  done
  sleep 1
  pids=$(project_pids "$dir" || true)
  [ -n "${pids:-}" ] || return 0
  for pid in $pids; do
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    kill -KILL "$pid" 2>/dev/null || true
  done
}

project_directory="$HOME/projects/$project_path"
operation_directory="$HOME/.dbx-tools/operations/projects/$project_path"
operation_lock="$operation_directory/lifecycle.lock"

if [ -d "$operation_lock" ]; then
  operation_pid=$(cat "$operation_lock/pid" 2>/dev/null || true)
  kill_tree "$operation_pid"
  rm -rf -- "$operation_lock"
fi

if [ -d "$project_directory" ]; then
  if [ -x "$HOME/.local/bin/mise" ]; then
    mise_bin="$HOME/.local/bin/mise"
  else
    mise_bin="$(command -v mise || true)"
  fi
  if [ -n "$mise_bin" ]; then
    (
      cd "$project_directory"
      if "$mise_bin" tasks ls --name-only --hidden | grep -Fxq "$uninstall_task"; then
        "$mise_bin" run "$uninstall_task"
      fi
    ) || printf 'mise run uninstall failed (ignored)\n' >&2
  fi
  stop_project_processes "$project_directory" || printf 'project process teardown failed (ignored)\n' >&2
fi
rm -rf -- "$project_directory"
rm -rf -- "$operation_directory"
