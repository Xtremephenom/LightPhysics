# Phase 1 evidence index

Phase 1 implementation evidence is intentionally split between the current
state record, the reproducible rebuild receipt, and the focused source tests.

| Evidence | What it proves |
|---|---|
| `docs/BUILD_STATE.md` | Current P1-E1…P1-E14 status, known limits, test counts, and resume commands |
| `docs/evidence/phase1/verify-rebuild.md` | Clean-clone native/Docker rebuild, network-disabled Linux suite, Playwright, and authenticated runtime smoke |
| `packages/warden/src/*test.ts` | Permission matrix, sessions, budgets, secrets, Human Channel signing, replay, evidence, and persistence |
| `apps/lpd/src/index.test.ts` | HTTP/WS authorization negatives, DNS-rebinding rejection, audit behavior, parity, and production kill-all revocation |
| `apps/cli/src/index.test.ts` | Memory commands, backup/restore, quiescence, and Ledger/CAS integration |
| `packages/memory/src/index.test.ts` | Project layout, reindex/rebuild, retrieval, resume budget, decisions, and Style Lock |
| `packages/runner/src/*test.ts` | Journal recovery, cancellation, safe points, backup, process-tree kill, revocation seam, and real git/filesystem qualification |
| `apps/electron/test/*.test.mjs` | Main-only Human Channel, safeStorage adapter, native confirmation, bounded preload bridge, replay/tamper rejection |
| `tests/e2e/studio-floor.spec.mjs` | Browser Security & Control boundary, no renderer signer/approval surface, and forged approval rejection |

## Current qualification receipt

- Tested commit: `71e2fbf36b9ae549e572ad3c31a77331279818df`
- Command: `LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 1`
- Result: PASS on Windows x64 with Docker Desktop and Linux/amd64 containers.
- Native: 57 root tests; 185 workspace tests; one Windows-only POSIX skip.
- Linux container: 57 root tests; 185 workspace tests; POSIX process-tree test passed.
- Electron `44.9.0`: Studio Floor smoke and native safeStorage Human Channel smoke passed.
- Playwright: one Studio Floor test passed.

## Formal closure

- The Owner formally authorized Phase 1 closure on 2026-10-20; the acknowledgement
  and explicit deferral of the remaining qualification limits are recorded in
  `docs/BUILD_STATE.md` §11.
- The formal repository close marker is the `phase1-done` tag on the close commit.
- Deferred limits remain `NOT RUN`/`NOT_QUALIFIED`; closure does not turn them into
  packaging, platform, hardware, or release qualification claims.

## Honest limits

- The Owner's real native enrollment click is not performed automatically; cancel/confirm behavior is covered by focused Electron tests.
- Electron packaging/distribution and non-Windows native safeStorage profiles are not qualified.
- The existing host-specific footprint report remains `NOT_QUALIFIED`.
- Approval methods remain absent from HTTP, WebSocket, CLI, preload, and agent facades.
