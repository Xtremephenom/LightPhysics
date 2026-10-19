#!/bin/sh
set -eu

# The token is supplied by the container runtime, never by the image build.
# lp's JSON output is discarded so health checks cannot echo request data or
# a secret-bearing diagnostic into Docker's health log.
if [ -z "${LP_TOKEN:-}" ]; then
  exit 1
fi

exec pnpm run lp -- doctor --json --quick >/dev/null 2>&1
