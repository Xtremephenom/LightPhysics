.PHONY: setup run test test-fast gui-smoke test-electron electron-footprint test-godot lint typecheck docker-build docker-test docker-smoke docker-run verify-rebuild \
        path-scan secret-scan env-sync ledger-lint adr-lint state-lint pin-check test-live test-hw

setup:
	pnpm install --frozen-lockfile

run:
	pnpm run run

test:
	pnpm run test

test-fast:
	pnpm run test:fast

gui-smoke:
	pnpm run gui-smoke

test-electron:
	pnpm run test:electron

electron-footprint:
	@printf '%s\n' 'Opt-in only: measuring the installed Electron shell; no Electron download; qualification remains NOT_QUALIFIED.'
	pnpm run measure:electron-footprint

test-godot:
	pnpm run test:godot

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

path-scan:
	pnpm run path-scan

secret-scan:
	pnpm run secret-scan

env-sync:
	pnpm run env-sync

ledger-lint:
	pnpm run ledger-lint

adr-lint:
	pnpm run adr-lint

state-lint:
	pnpm run state-lint

pin-check:
	pnpm run pin-check

docker-build:
	pnpm run docker-build

docker-test:
	pnpm run docker-test

docker-smoke:
	pnpm run docker-smoke

docker-run:
	pnpm run docker-run

verify-rebuild:
	pnpm run verify-rebuild

test-live:
	pnpm run test:live

test-hw:
	pnpm run test:hw
