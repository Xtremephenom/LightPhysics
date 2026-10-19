# Phase 0 Playwright Studio Floor smoke

## Command

```sh
corepack pnpm exec playwright test tests/e2e/studio-floor.spec.mjs
```

The Docker test image provisions the browser during its network-enabled
dependency stage and keeps it at `/opt/ms-playwright` for the non-root `lp`
user. Playwright `1.64.1` selects Chromium revision `1248` (Chrome for Testing
`156.0.8078.4`). The Debian 12 Chromium runtime/font packages are declared in
`docker/apt-packages.txt`; the test container does not install a browser.

```sh
docker build --target test --tag lightphysics:test .
docker run --rm --network none lightphysics:test
```

## Recorded result

```text
Running 1 test using 1 worker
1 passed
```

The test launched the existing `lpd` wrapper on an ephemeral loopback port, opened the real Studio Floor in headless Chromium, asserted the local CSP and same-origin requests, verified unauthenticated RPC rejection, entered the bearer value through the actual form, clicked Connect, observed the authenticated `system.info` request, and checked live status/version/platform fields in the rendered UI. It also clicked Refresh and verified another authenticated request.

## Recorded Docker result

From committed revision `5560cb0`, the network-disabled test container ran the
offline suite and then the real browser suite:

```text
$ docker run --rm --network none lightphysics:test
$ playwright test

Running 1 test using 1 worker
[1/1] tests/e2e/studio-floor.spec.mjs:160:1 › Studio Floor connects through the browser to live system.info
  1 passed
```

No browser download or external network request occurred in the test
container. The browser journey is the real `tests/e2e/studio-floor.spec.mjs`,
not a simulated pass.

## Scope boundary

This is browser coverage, not Electron coverage. It does not prove Electron
packaging, Windows installer coverage, visual snapshots, accessibility audits,
Linux secret-store behavior, or production release packaging. The browser
binary is installed in the Docker test image or outside the repository for a
local run and is not committed.
