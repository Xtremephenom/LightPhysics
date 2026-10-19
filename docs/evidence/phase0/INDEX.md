# Phase 0 evidence index

Evidence is tied to a committed source revision and states what it does not prove.

| Criterion | Status | Evidence |
| --- | --- | --- |
| P0-E1 | DEMONSTRATED | `docs/evidence/phase0/verify-rebuild.md`: `LP_SMOKE_TOKEN=<redacted> bash scripts/verify-rebuild.sh 0` passed from committed checkout `bbacc39`, including the network-disabled offline suite plus real Docker Playwright browser test, pinned FFmpeg base-stage smoke, and runtime smoke. |
| P0-E2 | DEMONSTRATED | `scripts/test.mjs` runs offline without network or GPU. |
| P0-E3 | DEMONSTRATED | `scripts/install-tools.mjs`, `scripts/install-ffmpeg.mjs`, `tests/install-tools.test.mjs`, and `docs/evidence/phase0/tool-installer.md` prove HTTPS/SHA-256/ZIP/tar.gz/tar.xz safety, GNU long-name handling, safe relative symlinks, executable-bit preservation, method-aware deflate flags, bounded HTTPS redirects, and UNKNOWN refusal offline; pinned Godot, uv, Blender, and FFmpeg Windows/Linux-Docker artifacts have real scoped smoke evidence in the phase evidence directory; unmeasured profiles and Node archive verification remain outside the claim. |
| P0-E4 | DEMONSTRATED | `apps/lpd/src/index.test.ts` covers HTTP and authenticated WebSocket JSON-RPC; `apps/cli/src/index.test.ts` and `apps/cli/src/tools.test.ts` cover `lp doctor --json` and bounded local Node/uv/Godot/Blender/ffmpeg probes. |
| P0-E5 | DEMONSTRATED | `packages/config/src/index.test.ts` and `packages/logging/src/index.test.ts`. |
| P0-E6 | PARTIAL | `scripts/gui-smoke.mjs` resource smoke, `docs/evidence/phase0/playwright-smoke.md` (1 local and 1 network-disabled Docker Chromium browser test passed), and `docs/evidence/phase0/electron-smoke.md` (1 un-packaged Electron shell smoke passed on the recorded Windows host); the opt-in Electron footprint is measured in `footprint-electron-win32.json`; Electron/Windows packaging, visual, accessibility, Linux secret-store behavior, and cross-platform memory remain unrun. |
| P0-E7 | DEMONSTRATED | `fixtures/mini-game/`, `scripts/godot-smoke.mjs`, `tests/godot-smoke.test.mjs`, `godot-win32.json`, `godot-linux-docker.json`, and `godot-import.json` prove the fixture/runner contract plus real pinned Godot 4.7.2 editor installs, boot/check-only smokes, and the separately scoped headless project-import smoke on Windows x64 and Linux x64 Docker; rendering, gameplay, packaging, export-template, native Linux, and other profiles remain outside the claim. |
| P0-E8 | DEMONSTRATED | `db-spike.json` proves Node SQLite WAL + FTS5 and qualifies sqlite-vec v0.1.9's three-vector KNN on Windows x64 and in the Linux x64 Docker test container; native non-x64 and unsupported package/platform results stay visible as `UNQUALIFIED`/`FALLBACK`. |
| P0-E9 | PARTIAL | `scripts/footprint.mjs` and `footprint-win32.json` record lpd-only host-specific cold start/working set; `scripts/electron-footprint.mjs` and `footprint-electron-win32.json` record the un-packaged Electron shell cold start plus main/renderer working-set/private-byte aggregates; qualification remains `NOT_QUALIFIED`. |
| P0-E10 | DEMONSTRATED | Offline hygiene scripts run inside `corepack pnpm run test`. |
| P0-E11 | DEMONSTRATED | `LICENSE`, `docs/adr/0018-project-license.md`, and `docs/licensing.md` record the Owner-selected MIT project license; third-party notices remain separate. |
| P0-E12 | DEMONSTRATED | `docs/evidence/phase0/phase-close.md` records the technical close audit and the accepted MIT decision; no broader qualification is claimed. |
