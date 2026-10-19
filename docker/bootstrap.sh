#!/bin/sh
# Tool bootstrap skeleton. It deliberately refuses to download a tool until
# tools.lock.json contains a vendor URL and a verified SHA-256 for it.
set -eu

mode="install"
if [ "${1:-}" = "--check-only" ]; then
  mode="check"
fi

if [ "$mode" = "check" ]; then
  printf '%s\n' "LightPhysics tool bootstrap: check-only (no downloads performed)"
  printf '%s\n' "Replace UNKNOWN lock entries with vendor-published URLs and hashes before installing tools."
  exit 0
fi

printf '%s\n' "LightPhysics tool bootstrap is not enabled for UNKNOWN lock entries." >&2
printf '%s\n' "Use a verified tools.lock.json and implement the hash-checked installer before requesting tool installation." >&2
exit 2
