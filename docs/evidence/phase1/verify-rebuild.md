# Phase 1 kernel checkpoint: committed-state rebuild

- **Date:** 2026-10-19
- **Tested commit:** `71e2fbf36b9ae549e572ad3c31a77331279818df`
- **Result:** PASS for the Phase 1 implementation checkpoint; the remaining Owner interaction and packaging limits are recorded below.
- **Profile:** Windows x64 host with Docker Desktop; Linux/amd64 containers;
  Docker server 29.7.2; Node 24.18.0 and pnpm 12.14.0.

## Command and scope

```sh
LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 1
```

The existing script's `1` argument labels its final receipt; it does not select
features or tests. This invocation tested the Phase 1 commit above from a clean
working tree and a fresh source clone. The smoke token was generated for this
local run, supplied only through the environment, and is not recorded here.
Temporary machine-specific directory settings and raw logs are omitted.

Dependency installation and image builds may use networking and existing caches.
This is a fresh-source rebuild, not a cache-free or network-free installation
claim. The Linux test container explicitly ran with `--network none`.

## Measured results

| Step | Result |
| --- | --- |
| Clean committed checkout and fresh clone | PASS |
| Native frozen-lockfile dependency installation | PASS; existing dependency cache reused |
| Native offline test command | PASS; 57 root tests and 185 workspace tests, typechecks and hygiene green; one Windows-only POSIX qualification skip |
| Docker test image build | PASS; frozen dependency install, preinstalled Chromium, offline install and test stage |
| Network-disabled Linux test container | PASS; 57 root tests and 185 workspace tests, typechecks and hygiene green; POSIX process-tree qualification passed in Linux |
| Real Studio Floor browser journey in that container | PASS; 1 Playwright test |
| Docker runtime image build | PASS |
| Authenticated runtime smoke | PASS; healthy container, unauthenticated rejection and authenticated `system.info` |
| Smoke cleanup | PASS; no matching smoke container remained after the script |

```text
VERIFY-REBUILD: PASS (phase 1, committed checkout, Docker runtime smoke)
```

## Image identifiers

Identifiers returned by `docker image inspect` after this run:

| Tag | Platform | Identifier |
| --- | --- | --- |
| `lightphysics:test` | `linux/amd64` | `sha256:79c5dc7ea888e752e5b7c72bfd7bf5025395a84fdb831d9893fa205e168ebeb4` |
| `lightphysics:runtime` | `linux/amd64` | `sha256:5b6666ab5e26795bcfbcbc704704efe74b7a0abc87e22e52e8bfbac6c6ce44b6` |

## Kernel behavior covered and remaining limits

- The suite covers real Ledger/CAS storage and tamper checks, persistent Runner
  jobs, cancellation, checkpoints, and a real child-process crash/recovery drill.
  That drill passed on the native Windows host and inside the Linux container;
  it does not qualify arbitrary POSIX process trees or daemon crash recovery.
- Human Channel tests cover signed, bounded `human` evidence, exact committed
  replay without duplicate appends, altered evidence and nonce reuse rejection,
  storage conflicts, and visible persistence failures. The Electron package also
  runs a real-runtime `safeStorage` adapter smoke with encrypted key/state and
  replay restoration.
- Fifty-four HTTP/WebSocket/in-process calls exercise three absent approval
  methods with agent, CLI, and Studio-Agent session contexts, using forged or
  already signed payloads. Four CLI command variants reject approval attempts
  without side effects. These are denial tests, not a completed authority system.
- Durable public enrollment/replay state is covered by the Warden file store and
  the Electron adapter's encrypted safeStorage files. The Security & Control
  panel now exposes only bounded status and a main-process native enrollment
  request; production Runner/Warden token revocation is exercised through the
  daemon kill-all lifecycle. The separately named DNS-rebinding test passes; no
  agent-facing approval method was added.
- The current Phase 1 surfaces have complete native and Linux rebuild coverage.
  Remaining limits are the optional real Owner confirmation click, Electron
  packaging/distribution, native non-Windows safeStorage profiles, and the
  host-specific footprint result remaining `NOT_QUALIFIED`. Base layers and
  dependency artifacts were reused from the local Docker cache; this is a
  fresh-source rebuild, not a cache-free installation claim.

See `docs/BUILD_STATE.md` for remaining work and
`docs/evidence/phase0/verify-rebuild.md` for the earlier Phase 0 proof.
