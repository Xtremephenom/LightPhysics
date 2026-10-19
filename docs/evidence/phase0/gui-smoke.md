# Phase 0 GUI browser-resource smoke

## Command

```sh
corepack pnpm run gui-smoke
```

The command starts the existing `lpd` executable wrapper with `LP_BIND=127.0.0.1`, a kernel-assigned ephemeral port, and a test bearer value held only in the child process environment. It prints neither the bearer value nor the selected port. The daemon is stopped in a `finally` path after the HTTP checks complete.

## Recorded result

```text
gui-smoke: browser-resource smoke
gui-smoke: daemon ready (loopback, ephemeral port)
gui-smoke: Studio Floor assets fetched over HTTP
gui-smoke: shell/status-bar markers: PASS
gui-smoke: strict CSP and no remote CDN: PASS
gui-smoke: authenticated system.info path: PASS
gui-smoke: PASS
```

The smoke fetches `/`, `/app.js`, and `/styles.css`, requiring HTTP 200, the local strict CSP, and no remote URL references. It checks the visible shell and status-bar strings, the static `system.info`/bearer/status-update path in `app.js`, rejects an unauthenticated `system.info` request with HTTP 401, and accepts the authenticated request with the expected `lpd`, `LightPhysics`, loopback, and selected-port fields.

## Scope boundary

This is a browser-resource smoke and a prerequisite for real GUI coverage. It does **not** launch a browser or Electron, execute `app.js` in a browser context, render or inspect DOM/layout, click the token form or other controls, test browser WebSockets, capture visual snapshots, run an accessibility audit, measure GUI performance, or run Playwright.
