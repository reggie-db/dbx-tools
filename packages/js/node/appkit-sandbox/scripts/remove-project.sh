#!/bin/sh
set -euf

project_path="$1"
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

rm -rf -- "$HOME/projects/$project_path"
