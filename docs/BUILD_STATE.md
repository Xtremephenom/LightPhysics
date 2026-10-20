# BUILD_STATE — LightPhysics
<!-- Rewritten for the Phase 2 documentation closure; history lives in git. Keep this file short and honest. -->

**Phase:** 2 — Forge (offline/mock surfaces formally closed; real-model qualification open)
**Session:** Phase 2 documentation closure
**Date:** 2026-10-20
**HEAD:** inspect with `git rev-parse --short HEAD`; implementation commits through `9bed4aa`, documentation closure committed
**Tree:** clean after this state file is committed

**Baseline `make test`:** green — equivalent `corepack pnpm run test`; 289 passed / 0 failed / 1 skipped (59 root tests; 230 workspace tests; Windows-only POSIX process-tree qualification skip). Node 24.18.0, pnpm 12.14.0.

**Docker status:** PASS — `scripts/verify-rebuild.sh 2` completed from a clean
checkout: fresh clone, frozen install, native and network-disabled tests,
Playwright, Docker test/runtime builds, and authenticated runtime smoke. See
`docs/evidence/phase2/verify-rebuild.md`.

## 1. Phase goal & exit criteria

The offline/mock Forge surface is implemented and tested. Status below is scoped
to repository fixtures and injected seams; it does not qualify a real model,
hosted vendor, GPU, or Owner machine.

| ID | Criterion | Status | Evidence |
|---|---|---|---|
| P2-E1 | Catalog schemas/lint, license, hardware, fidelity, qualification | demonstrated for 5 fixture records | `scripts/catalog-lint.mjs`, `catalog/`, `tests/catalog-lint.test.mjs` |
| P2-E2 | All taxonomy capability schemas and JSON-Schema goldens | demonstrated; 40 IDs | `packages/schemas/src/forge.test.ts`, `packages/schemas/goldens/forge-api.json` |
| P2-E3 | Mock failures and adapter error mapping | demonstrated for implemented mock/HTTP/ComfyUI/worker seams | `packages/forge/src/adapters.test.ts`, `domain.test.ts` |
| P2-E4 | Fake ComfyUI/OpenAI-compatible/Python-worker contracts | demonstrated for injected ComfyUI submit/poll/fetch/cancel, recorded OpenAI-compatible response, and Python-worker lifecycle/audio fixture | `packages/forge/src/adapters.test.ts`, `domain.test.ts`, `fixtures/forge/openai-compatible-success.json` |
| P2-E5 | Ordered fallback, privacy, rewrite/retry, digest-only egress | demonstrated by unit, daemon, and parity tests | `packages/forge/src/routing.test.ts`, `apps/lpd/src/index.test.ts` |
| P2-E6 | 4 GB Governor admission/swap/downshift/provenance | partial: mock labels, resource normalization, and one-heavy-model scheduling pass; Forge-to-Governor downshift integration is not evidenced | `packages/forge/src/hardware.ts`, `domain.test.ts` |
| P2-E7 | Estimate/confirmation, caps, actuals, breaker | demonstrated with deterministic spend and Warden/daemon tests; no paid call ran | `packages/forge/src/domain.test.ts`, `apps/lpd/src/index.test.ts` |
| P2-E8 | Qualification records and honest real-model status | demonstrated for record shape and `NOT_RUN`/`UNQUALIFIED` guards; no real qualification exists | `packages/forge/src/qualification.ts`, `domain.test.ts`, §8 below |
| P2-E9 | Contact sheets, measured/AI perception, text summary | demonstrated for deterministic contact-sheet descriptors, measured/AI separation, and text summary | `packages/forge/src/perception.ts`, `domain.test.ts` |
| P2-E10 | Style Lock injection and provenance version | demonstrated for image requests and mock result provenance | `packages/forge/src/style-lock.ts`, `domain.test.ts`, `apps/lpd/src/forge-runtime.ts` |
| P2-E11 | Acquisition integrity, pickle refusal, disk/range/checksum/license hash | demonstrated for allowed formats, pickle refusal, URL, disk preflight, bounded ranges, size/checksum, resume, and license hash | `packages/forge/src/acquisition.ts`, `domain.test.ts` |
| P2-E12 | `forge.create`, exploration artifact, recipe/provenance, client parity | demonstrated offline; consult demo and daemon parity pass | `apps/lpd/src/index.test.ts`, `scripts/forge-consult-demo.mjs`, `tests/forge-consult-demo.test.mjs` |
| P2-E13 | Atlas statuses/sources and model-license verification | partial: every row is conservatively labelled, but primary-source/vendor verification is not present | `docs/research/model-atlas-verified.md`, `docs/research/entries/R-014.md`, `catalog/models/` |
| P2-E14 | Read-only Models & Providers GUI with mock profile | demonstrated by one Playwright test; labels are offline fixture content | `tests/e2e/studio-floor.spec.mjs`, `apps/gui/index.html`, `docs/evidence/phase2/INDEX.md` |

## 2. Done this session

- Audited Phase 2 implementation, §6, current worktree, and available checks.
- Ran the native/offline receipts listed in `docs/evidence/phase2/INDEX.md`.
- Added the Phase 2 evidence index and the successful committed rebuild receipt.
- Replaced the stale Phase 1 state with this Phase 2 state; no application code,
  package manifest, lockfile, or other pre-existing uncommitted doc was changed.

## 3. In progress

- Phase 2 offline/mock implementation and rebuild evidence are complete for the
  recorded scope. P2-E6 and P2-E13 retain the qualification/research limits
  stated above; they are not silently promoted to real-hardware or vendor proof.
- Real model/provider research and hardware qualification remain external or
  unrun work. The ADR, Research Ledger, model-atlas, and evidence closure are
  committed with this phase.

## 4. Next 3 actions

1. Begin Phase 3 only from this clean, tagged checkpoint; preserve the no-approval and qualification boundaries.
2. Run `make test-hw`/the eventual hardware harness on the Owner machine if real-model qualification is desired; bind any result to its profile and versions.
3. Reverify R-014 from primary model/vendor sources before widening atlas or commercial claims.

## 5. Decisions made

- ADR-0020 — normalized Forge adapters, bounded fixture catalog, typed failures,
  privacy/egress records, spend gates, and explicit qualification boundary.
- R-014 — atlas candidates remain `ASSUMED` until primary-source and Owner-run
  evidence exists; fixture/mock fallback is the safe offline path.

## 6. Unverified

- R-014: real model licenses, quality, VRAM/latency, hosted API shapes, and commercial suitability; fallback is deterministic mock/fixture routing.
- `test:live`: NOT RUN; no hosted vendor, provider key, network qualification, or paid call was used.
- `test:hw`: NOT RUN; no GPU/NVML/`nvidia-smi` or Owner hardware result is present.
- Real model/provider research, hardware qualification, and live hosted calls remain unrun; the deterministic fixtures are not real creative-quality evidence.
- Electron packaging, non-Windows safeStorage, and host-specific footprint remain unqualified from Phase 1.

## 7. Known defects

- Forge hardware labels/scheduling are mock/domain primitives; automatic downshift is not wired through Runner/Governor provenance.
- `ComfyUIWorkflowAdapter.fetch()` exists, but the run path returns a view URI and no focused fetch contract receipt exists.
- The Python-worker path is an injected stdio JSON-RPC seam; no real uv-created worker environment or model process is qualified.
- The Models & Providers screen is a static read-only fixture presentation; it does not load live provider/model records or accept secrets.
- `scripts/verify-rebuild.sh` requires a clean committed tree and a Docker-capable
  Linux environment; the Phase 2 receipt records a successful run from the
  reviewed commit.

## 8. Opt-in suites

| Suite | Last run | Profile | Result |
|---|---|---|---|
| `corepack pnpm run test:e2e` | 2026-10-20 | Windows x64, Node 24.18.0, Playwright | PASS — 1 Studio Floor/Models test |
| `corepack pnpm run forge-demo` | 2026-10-20 | Windows x64, Node 24.18.0, mock adapter | PASS — exploration artifact, 3-record verified Ledger chain |
| `scripts/verify-rebuild.sh 2` | 2026-10-20 | Windows x64 host with Docker Desktop Linux engine | PASS — clean clone/install, native and network-disabled tests, Playwright, Docker builds, runtime smoke |
| `test:live` | — | hosted/network | NOT RUN |
| `test:hw` | — | Owner hardware/GPU | NOT RUN |

## 9. Footprint metrics vs budgets

| Metric | Budget | Measured | Where measured |
|---|---|---|---|
| lpd idle RAM | ≤250 MB | 73,203,712 bytes (~69.8 MiB) | Phase 0 host report; not Phase 2 qualification |
| GUI idle RAM | ≤400 MB | 186,508,902-byte mean working set | Phase 0 Electron report; host-specific, not qualified |
| `project.resume` | ≤2,500 tokens | bounded by unit test | `packages/memory/src/index.test.ts` |
| real Forge model VRAM/latency | — | NOT MEASURED | no GPU or real model run |

## 10. Spend

Default `$0`; no hosted calls, provider keys, paid calls, or paid research were used.

## 11. Owner asks pending

- Optionally run the hardware harness and, with a bounded spend cap, an optional live provider fixture; store credentials through Warden/GUI, never in files or chat.

## 12. How to resume

```text
Read docs/BUILD_STATE.md and docs/evidence/phase2/INDEX.md.
corepack pnpm install --frozen-lockfile
corepack pnpm run test
corepack pnpm run typecheck
node scripts/catalog-lint.mjs --json
corepack pnpm run forge-demo
corepack pnpm run test:e2e
LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 2
```

The last command is only for a clean committed checkout with Docker. Do not
interpret the fixture `QUALIFIED` badges or native green tests as real-model,
hosted-vendor, GPU, Owner-hardware, packaging, or creative-quality qualification.
