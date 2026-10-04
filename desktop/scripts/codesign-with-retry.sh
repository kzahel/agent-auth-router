#!/usr/bin/env bash
# Retry only Apple's observed transient timestamp failure; never omit timestamps.
set -euo pipefail
error_file="$(mktemp "${TMPDIR:-/tmp}/aar-codesign.XXXXXX")"
trap 'rm -f "$error_file"' EXIT
for attempt in 1 2 3; do
  if codesign "$@" 2>"$error_file"; then
    cat "$error_file" >&2
    exit 0
  else
    status=$?
  fi
  cat "$error_file" >&2
  if [[ "$attempt" == 3 ]] || ! grep -Fq 'A timestamp was expected but was not found.' "$error_file"; then
    exit "$status"
  fi
  echo "Apple signing timestamp unavailable; retrying ($attempt/3)." >&2
  sleep 5
done
