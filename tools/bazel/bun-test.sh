#!/bin/sh
set -eu

runner="$1"
shift
status=0
for test_file in "$@"; do
    "$runner" test "$test_file" --max-concurrency=1 --pass-with-no-tests || status=$?
done
exit "$status"
