# BUILD_STATE — LightPhysics
<!-- Rewritten each session; history lives in git. Keep this file short and honest. -->

**Phase:** 1 — Kernel (formally closed; Warden slice 1d)
**Session:** 19
**Date:** 2026-10-20
**HEAD:** inspect with `git rev-parse --short HEAD`; code/rebuild checkpoint `71e2fbf`
**Tree:** clean after this state file is committed

**Baseline `make test`:** green — 57 passed / 0 failed / 0 skipped (root tests); 185 workspace tests passed / 0 failed / 1 skipped, the explicit Windows-only POSIX qualification skip. The host uses the equivalent `corepack pnpm run test` because native `make` is unavailable. Node `24.18.0`, pnpm `12.14.0`, Electron `44.9.0`.

**Docker status:** `scripts/verify-rebuild.sh 1` passed from clean checkout `71e2fbf`; fresh clone, native and network-disabled Linux tests, Playwright, Docker test/runtime builds, POSIX process-tree qualification, and authenticated runtime smoke all passed. Current Phase 1 implementation criteria are complete for the implemented surfaces; the Owner has formally authorized closure with the documented interaction, packaging, platform, and footprint limits explicitly deferred and unqualified.

## 1. Phase goal & exit criteria

Phase 1 turns the walking skeleton into a trustworthy substrate: persistent Ledger, Warden permissions/sessions/secrets, a Human Channel that agents cannot reach, resumable Runner jobs, Resource Governor, git-backed project Memory, and the Studio Floor security boundary. No creative models or MCP surface are in scope.

| ID | Criterion | Status | Evidence |
|----|-----------|--------|----------|
| P1-E1 / 1a | Core schemas, typed errors, idempotency, events, clients, and goldens | demonstrated for the current 41 registered schemas and client contracts; later-phase methods remain intentionally absent | `packages/schemas/src/`, `packages/schemas/goldens/core-api.json`, `packages/core-api/src/`, `tests/bootstrap.test.ts` |
| P1-E2 / 1b | Ledger append-only chain, tamper detection, and CAS | demonstrated for persistent WAL/migrations, typed records, chain verification, tamper cases, CAS dedupe, and path/hash rejection | `packages/ledger/src/index.ts`, `packages/ledger/src/index.test.ts` |
| P1-E3 / 1c | Runner crash recovery, cancellation, kill-all, safe points, and backup | demonstrated for real crash recovery, safe-point/backup round-trip, daemon quiescence, server-owned Supervisor kill-all, and Warden session revocation after process-tree stop; direct embedded `server.close()` callers must use `server.killAll()` first | `packages/runner/src/`, `apps/cli/src/`, `apps/lpd/src/`, `apps/lpd/src/index.test.ts` |
| P1-E4 / 1c | Governor decisions under the reference mock profile | demonstrated for admission, queue/deny, priority, accounting, preemption, and downshift | `packages/runner/src/governor.ts`, `packages/runner/src/index.test.ts` |
| P1-E5 / 1d | Warden permission/session/secret core | demonstrated for the focused in-memory matrix, scopes, expiry/revocation, budgets, secret references, and redaction; broader OS keychain coverage is outside the core package | `packages/warden/src/policy.ts`, `session.ts`, `secrets.ts`, `packages/warden/src/*test.ts` |
| P1-E6 / 1d | Human Channel enrollment, signing, verification, replay rejection, and negative suite | demonstrated for Warden core, durable state, Electron safeStorage, qualified JS adapter, native runtime smoke, main-only receipts, bounded GUI status/enrollment, native confirmation cancel/confirm tests, and HTTP/WS/CLI/in-process negatives; a real Owner click remains opt-in | `packages/warden/src/`, `apps/electron/src/`, `apps/electron/test/`, `apps/gui/`, `apps/lpd/src/index.test.ts`, `docs/adr/0010-human-channel.md` |
| P1-E7 / 1e | `lp init`, reindex, rebuildable Memory, approvals, and immutable Style Lock | demonstrated for the current project layout, reindex/rebuild, decisions, and Style Lock tests | `packages/memory/src/index.ts`, `packages/memory/src/index.test.ts`, `apps/cli/src/` |
| P1-E8 / 1e | Hybrid FTS5/vector retrieval golden | demonstrated with deterministic hashed embeddings and SQLite FTS5/vector tests | `packages/memory/src/index.ts`, `packages/memory/src/index.test.ts` |
| P1-E9 / 1e | Bounded `project.resume` brief | demonstrated with required continuity fields and the 2,500-token budget test | `packages/memory/src/index.ts`, `packages/memory/src/index.test.ts`, `apps/lpd/src/index.ts` |
| P1-E10 / 1f | Network/auth hardening | demonstrated for loopback bind, Origin/Host, bearer auth, HTTP/WS rejection, bounded auth-failure limiting, and explicit DNS-rebinding attempts | `apps/lpd/src/index.ts`, `apps/lpd/src/index.test.ts`, `apps/electron/src/security.mjs` |
| P1-E11 / 1f | Path jail, rollback, backup/restore round-trip | demonstrated for traversal/absolute/UNC/device/symlink bounds, deterministic manifests, restore, and real git/filesystem qualification; POSIX process-tree coverage is skipped on Windows | `packages/runner/src/safe-points.ts`, `packages/runner/src/real-os-qualification.integration.test.ts`, `apps/cli/src/index.test.ts` |
| P1-E12 / 1a | InProcessClient/RemoteClient parity with identical Ledger outcomes | demonstrated across independent lpd kernels with replay, permissions, cancellation, audit records, and chain verification | `apps/lpd/src/index.test.ts`, `packages/core-api/src/client.test.ts` |
| P1-E13 / 1f | Studio Floor, Security & Control, and renderer-forged approval rejection | demonstrated for Studio Floor GUI/Electron/Playwright, bounded Security & Control status/enrollment, metadata-only preload, native confirmation cancel/confirm tests, and renderer-forged approval rejection; interactive native modal automation remains opt-in | `apps/gui/`, `tests/e2e/studio-floor.spec.mjs`, `apps/electron/src/`, `apps/electron/test/` |
| P1-E14 / 1c/1d | Offline contract tests and footprint evidence | demonstrated for current Phase 1 surfaces: native suites, applicable security tests, Linux/Docker rebuild, Playwright, Electron smokes, and focused footprint evidence pass; host footprint remains `NOT_QUALIFIED` and future-phase quarantine/pickle tests have no Phase 1 surface | `scripts/test.mjs`, `scripts/verify-rebuild.sh`, `docs/evidence/phase1/INDEX.md`, `docs/evidence/phase1/verify-rebuild.md` |

## 2. Done this session

- Added `packages/memory` with `lp init`, `project reindex`, `project resume`, deterministic FTS5/vector retrieval, Style Lock, Decision Log, Production Board, path jail, symlink rejection, bounded files, and metadata validation.
- Added CLI backup quiescence with bounded daemon shutdown, PID cleanup, typed timeout failure, and backup round-trip coverage.
- Exposed Memory through lpd and the Studio Floor; extended schemas and regenerated `packages/schemas/goldens/core-api.json`.
- Added the Electron safeStorage key store and main-only Human Channel controller/listener. The renderer/preload has no approval, signer, grant, or signature facade.
- Added `apps/electron/src/human-channel-adapter.mjs`, a Node-built-in Ed25519 adapter with encrypted bounded enrollment/replay state, plus `test:electron-human-channel` using the real Electron runtime and native `safeStorage`.
- Added authentication-failure rate limiting in HTTP and WebSocket paths.
- Added Runner token-revocation callback/interface outcomes and real temporary-directory git/filesystem qualification.
- Wired the lpd-owned Supervisor kill-all lifecycle to revoke all active Warden sessions after confirmed process-tree stops; signal shutdown uses this path before server close.
- Added independent in-process/HTTP parity with deterministic Ledger outcomes.
- Added an explicit lpd DNS-rebinding regression covering hostile Host, Origin, and wrong-port combinations with a valid bearer.
- Added Electron-main Security & Control enrollment with bounded status/request IPC, native confirmation, safeStorage-backed state, renderer boundary tests, and Studio Floor e2e assertions.
- Fixed the Docker dependency layer to include the Memory workspace manifest.

### Verification receipts

- `corepack pnpm run test` — PASS: 57 root, 185 workspace, 1 Windows-only POSIX skip.
- `corepack pnpm run test:electron` — PASS: Electron `44.9.0` rendered the loopback Studio Floor and exited cleanly.
- `corepack pnpm run test:electron-human-channel` — PASS: real Electron process used native `safeStorage`, qualified the adapter, and restored replay state.
- Electron Human Channel package tests — 13 passed; Warden tests — 54 passed; Runner — 25 passed/1 skipped; Memory — 7 passed; CLI — 18 passed; lpd — 20 passed; schemas — 11 passed; Core API — 16 passed.
- `corepack pnpm run test:e2e` — PASS: one Studio Floor test; `corepack pnpm run typecheck` — PASS.
- `scripts/verify-rebuild.sh 1` — PASS for commit `71e2fbf`; see `docs/evidence/phase1/INDEX.md`.
- `git diff --check` — PASS before the adapter commit.

## 3. In progress

- Phase 1 is formally closed by the Owner acknowledgement recorded in §11; no known implementation blocker remains for the current surfaces.
- Optional Owner confirmation, Electron packaging/distribution, non-Windows safeStorage qualification, and hardware footprint qualification remain explicitly deferred and outside the automated claim.
- Approval methods remain absent from HTTP, WS, CLI, preload, and agent facades by design.

## 4. Next 3 actions

1. Preserve the documented deferred qualification limits; do not convert `NOT RUN`/`NOT_QUALIFIED` into release claims.
2. Preserve the no-approval-facade boundary when adding future capabilities; do not add an agent-facing approval method.
3. Begin the next roadmap phase only from a clean tree with this close receipt and the `phase1-done` tag present.

## 5. Decisions made

- The packaged Electron path uses a Node-built-in Ed25519 adapter with Electron `safeStorage` encrypted key/state files; injected adapters remain explicitly unqualified test seams.
- Main-process confirmation is the only enrollment authority. Signed approvals are consumed inside the main-process controller and returned only as bounded verified receipts without signatures or private keys.
- POSIX process-tree qualification remains platform-specific; Windows reports the explicit skip rather than claiming Linux behavior.
- Phase 1 is formally closed with evidence-backed implementation criteria for the current surfaces; no release/package qualification is implied by the code checkpoint.

## 6. Unverified

- Optional real Owner enrollment click in a native dialog.
- Electron packaging/distribution and native non-Windows safeStorage profiles.
- Host-specific footprint qualification; the current report remains `NOT_QUALIFIED`.

## 7. Known defects

- `apps/gui/` remains a static browser shell with token entry and project-resume display; its Security & Control control is intentionally limited to bounded Electron-main status/enrollment requests.
- Direct embedded callers that invoke `server.close()` without first calling `server.killAll()` can bypass the production revocation lifecycle; the executable signal path is wired correctly.
- `make` is not installed on the current host; `corepack pnpm run test` is the reproducible local equivalent.

## 8. Opt-in suites

| Suite | Last run | Profile | Result |
|-------|-----------|---------|--------|
| `test:electron` | 2026-10-19 | Windows x64, Node 24.18.0, Electron 44.9.0 | PASS — loopback Studio Floor rendered and exited cleanly |
| `test:electron-human-channel` | 2026-10-19 | Windows x64, Node 24.18.0, Electron 44.9.0 | PASS — native safeStorage adapter and replay persistence |
| `verify-rebuild 1` | 2026-10-19 | Windows x64 host with Linux/amd64 Docker | PASS — tested commit `71e2fbf`, network-disabled suite, Playwright, runtime smoke |
| `test:live` | — | network/hosted | NOT RUN |
| `test:hw` | — | Owner hardware | NOT RUN |

## 9. Footprint metrics vs budgets

| Metric | Budget | Measured | Where measured |
|--------|--------|----------|----------------|
| lpd idle RAM | ≤ 250 MB | 73,203,712 bytes (~69.8 MiB) | host-specific Phase 0 measurement; not a Phase 1 qualification |
| GUI idle RAM | ≤ 400 MB | 186,508,902 bytes mean working set | Electron footprint smoke; host-specific and not qualified |
| `project.resume` | ≤ 2,500 tokens | bounded by unit test | `packages/memory/src/index.test.ts` |

## 10. Spend

Default `$0`; no hosted calls or paid research performed.

## 11. Owner asks pending

The Owner formally authorized Phase 1 closure on 2026-10-20 with the statement: “phase 1 is officially complete. i give the formal permission.” This acknowledgement explicitly accepts and defers the remaining qualification limits: the optional real native enrollment click, Electron packaging/distribution, non-Windows native `safeStorage` profiles, and host-specific footprint qualification. These remain `NOT RUN`/`NOT_QUALIFIED` and are not release claims. The automated native cancel/confirm coverage remains the evidence for the implemented enrollment path. No credential or secret should be pasted into chat.

## 12. How to resume

```text
corepack pnpm install --frozen-lockfile
corepack pnpm run test
corepack pnpm run test:electron
corepack pnpm run test:electron-human-channel
corepack pnpm run test:e2e
corepack pnpm run typecheck
LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 1
```

Read this file with `docs/evidence/phase1/INDEX.md`, `docs/pack/01_MASTER_PROMPT.md`, `docs/pack/03_ARCHITECTURE.md`, `docs/pack/09_SECURITY_RECOVERY_PROVENANCE.md`, and Phase 1 §5 of `docs/pack/11_ROADMAP_AND_PHASE_PROMPTS.md`. The current code is in `packages/memory/`, `packages/warden/`, `packages/runner/`, `apps/lpd/`, `apps/cli/`, `apps/gui/`, and `apps/electron/`; the current Docker receipt is `docs/evidence/phase1/verify-rebuild.md`.
