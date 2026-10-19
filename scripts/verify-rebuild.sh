#!/usr/bin/env bash
set -euo pipefail

PHASE="${1:-0}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
SMOKE_TOKEN="${LP_SMOKE_TOKEN:-}"
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s ==\n' "$*"; }
fail() { printf 'VERIFY-REBUILD FAIL: %s\n' "$*" >&2; exit 1; }

[[ -n "$SMOKE_TOKEN" ]] || fail "set LP_SMOKE_TOKEN to run the authenticated runtime smoke"

step "committed state only"
[[ -z "$(git -C "$ROOT" status --porcelain)" ]] || fail "working tree is not clean; commit the reviewed bootstrap first"

step "fresh clone"
git clone --quiet "$ROOT" "$WORK/clone"
cd "$WORK/clone"

step "required root files"
for file in README.md Dockerfile .dockerignore .env.example .node-version .python-version tools.lock.json pnpm-lock.yaml Makefile .gitattributes docs/BUILD_STATE.md; do
  [[ -f "$file" ]] || fail "missing $file"
done

step "native dependency install (build-time network only)"
corepack pnpm install --frozen-lockfile

step "offline native hygiene"
corepack pnpm run test

step "Docker test image"
docker build --target test --tag lightphysics:test .

step "network-disabled test container"
docker run --rm --network none lightphysics:test

step "Docker runtime image"
docker build --target runtime --tag lightphysics:runtime .

step "authenticated runtime smoke"
LP_TOKEN="$SMOKE_TOKEN" node scripts/docker-smoke.mjs

printf 'VERIFY-REBUILD: PASS (phase %s, committed checkout, Docker runtime smoke)\n' "$PHASE"
