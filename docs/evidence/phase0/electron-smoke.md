# Phase 0 Electron shell smoke

## Command

The pinned Electron package is installed by the frozen workspace install. Its
platform executable is provisioned separately by the package's explicit setup
command; this is intentionally not done by the smoke runner.

```sh
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm --filter @lightphysics/electron exec install-electron
corepack.cmd pnpm run test:electron
```

The runner starts the existing authenticated `lpd` entry with a test bearer in
that child environment, uses an operating-system-selected loopback port, and
passes only a validated `--smoke-url` to the direct Electron executable. It
removes token-like environment variables from the Electron child. It does not
invoke a shell, use a package manager, download Electron, or write a token to
the workspace.

## Recorded result

Host: Windows (`win32`), Node `24.18.0`, pinned Electron `44.9.0`, with local
display support.

```text
electron-smoke: opt-in Electron Studio Floor smoke
electron-smoke: Electron 44.9.0 rendered the loopback Studio Floor
electron-smoke: title, Studio Floor/status-bar markers, same-origin URL, and strict local CSP: PASS
electron-smoke: lpd and Electron exited cleanly
electron-smoke: PASS
```

This is a real shell smoke result, not a simulated or offline-test result. The
deterministic URL, renderer-marker, and process/argument tests remain in
`pnpm run test`; the Electron process itself is never started by that required
offline command.

## Scope boundary

The result demonstrates the current un-packaged Electron main/preload path on
the recorded host: validated loopback loading, navigation denial, renderer
markers, same-origin location, strict local CSP observation, and clean child
shutdown. It does not prove an Electron installer, Windows packaging, Linux
secret-store qualification, browser packaging, visual/accessibility coverage,
or production release behavior. No
`safeStorage` integration is implemented or qualified here. A future machine
without the Electron executable or display support must receive a visible
`ELECTRON_NOT_FOUND`/launch failure instead of a simulated pass.
