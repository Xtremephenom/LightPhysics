# Phase 2 evidence index

This index records the evidence for the Phase 2 implementation and committed
documentation closure on 2026-10-20. It covers deterministic offline/native checks and
explicitly identifies proof that is partial or not run. The Docker claim is
limited to reproducible build/test/runtime behavior; no real model, hosted
vendor, GPU, or Owner-hardware claim is made here.

## Exit-criteria map

| ID | Status | Evidence in repository |
|---|---|---|
| P2-E1 | DEMONSTRATED (fixture scope) | `node scripts/catalog-lint.mjs --json` → 5 records, 6872 bytes, no warnings; `catalog/`, `scripts/catalog-lint.mjs`, `tests/catalog-lint.test.mjs`, `packages/forge/src/catalog.test.ts` |
| P2-E2 | DEMONSTRATED | `packages/schemas/src/forge.test.ts` checks all 40 capability request/response schemas and reproducible `packages/schemas/goldens/forge-api.json`; `packages/forge/src/capabilities.test.ts` checks the taxonomy |
| P2-E3 | DEMONSTRATED (implemented seams) | `packages/forge/src/adapters.test.ts` covers mock failures and HTTP mapping; `packages/forge/src/domain.test.ts` covers the worker seam and deterministic worker result |
| P2-E4 | DEMONSTRATED (fixture scope) | `packages/forge/src/adapters.test.ts` covers ComfyUI submit/poll/fetch/cancel/timeout/OOM and a recorded OpenAI-compatible response; `domain.test.ts` covers Python-worker lifecycle/audio analysis. `fixtures/forge/openai-compatible-success.json` is the bounded response fixture |
| P2-E5 | DEMONSTRATED | `packages/forge/src/routing.test.ts` and Forge portions of `apps/lpd/src/index.test.ts` cover ordered fallback, local-only blocking, one policy rewrite, stricter malformed retry, and hash/provider-only egress |
| P2-E6 | PARTIAL | `packages/forge/src/hardware.ts` and `domain.test.ts` cover reference-4GB labels, resource normalization, and one-heavy-model eviction. No Forge-to-Runner Governor downshift/provenance receipt is present |
| P2-E7 | DEMONSTRATED (deterministic scope) | `packages/forge/src/domain.test.ts` covers confirmation, daily cap, actuals, and breaker; `apps/lpd/src/index.test.ts` covers Warden spend authorization/budget rejection. No paid provider call ran |
| P2-E8 | DEMONSTRATED (record guard scope) | `packages/forge/src/qualification.ts` and `domain.test.ts` cover `NOT_RUN`, `UNQUALIFIED`, and labeled passing checks; catalog records are fixture-scoped. No real-model qualification exists |
| P2-E9 | DEMONSTRATED (deterministic scope) | `packages/forge/src/perception.ts` and `domain.test.ts` cover measured vs AI-described values, complete text summaries, and deterministic contact-sheet labels/fallback summaries |
| P2-E10 | DEMONSTRATED | `packages/forge/src/style-lock.ts`, `domain.test.ts`, and `apps/lpd/src/forge-runtime.ts` cover image-request injection and versioned provenance |
| P2-E11 | DEMONSTRATED (fixture scope) | `packages/forge/src/acquisition.ts` and `domain.test.ts` cover GGUF/safetensors allowlisting, pickle refusal, URL validation, disk preflight before transport, bounded ranged fixture download, response size, checksum, resume, and license-text hash |
| P2-E12 | DEMONSTRATED | `apps/lpd/src/index.test.ts` covers HTTP/in-process parity, exploration state, recipe/provenance, Ledger equality, replay, privacy, and error mapping; `scripts/forge-consult-demo.mjs` plus `tests/forge-consult-demo.test.mjs` cover the consult receipt |
| P2-E13 | PARTIAL | `docs/research/model-atlas-verified.md`, `docs/research/entries/R-014.md`, `docs/research/LEDGER.md`, and `catalog/models/` record conservative fixture/atlas status. Primary-source model-license and hosted-API verification is not present |
| P2-E14 | DEMONSTRATED (one native browser run) | `corepack pnpm run test:e2e` → 1 passed; `tests/e2e/studio-floor.spec.mjs` checks the read-only Models & Providers view, mock hardware labels, qualification disclaimer, same-origin boundary, and forged approval rejection |

## Native receipts

- `corepack pnpm run test` — PASS. Root Node tests: 59 passed. Workspace tests:
  230 passed, 0 failed, 1 skipped (Windows-only POSIX process-tree
  qualification). Hygiene in the same run passed: path, secret, env, Ledger,
  ADR, state, pins, SQLite/FTS5, config, catalog, and GUI-resource smoke.
- `corepack pnpm run typecheck` — PASS for all reported workspace packages/apps.
- `node scripts/catalog-lint.mjs --json` — `{"ok":true,"files":5,"bytes":6872,"warnings":[]}`.
- `corepack pnpm run forge-demo` — PASS: mock `image.generate`, exploration
  artifact, digest-only provenance, 3 Ledger records, chain `verified`.
- `corepack pnpm run test:e2e` — PASS: 1 Playwright test in 2.1 seconds.
- `git diff --check` — PASS after this documentation update.
- `LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 2` — PASS:
  fresh clone, frozen install, native and network-disabled tests, Playwright,
  Docker test/runtime builds, and authenticated runtime smoke.

## Related decisions and limits

- `docs/adr/0020-forge-adapters-and-catalog.md` records the normalized adapter,
  catalog, privacy, spend, provenance, and qualification boundary.
- `docs/research/entries/R-014.md` and `docs/research/BACKLOG.md` keep real-model
  and hosted verification open. `model-atlas-verified.md` is conservative
  repository review, not vendor research or hardware qualification.
- `docs/evidence/phase2/verify-rebuild.md` records the Phase 2 committed rebuild
  proof. The Phase 1 receipt is historical and is not reused as Phase 2 evidence.
