# Phase 2 rebuild verification receipt

- **Date:** 2026-10-20
- **Reviewed implementation HEAD:** `9bed4aa`
- **Profile for native checks:** Windows x64, Node 24.18.0, pnpm 12.14.0
- **Phase 2 committed-state rebuild:** **PASS**

`scripts/verify-rebuild.sh 2` was invoked from the clean committed checkout.
The fresh clone, frozen install, offline native hygiene, Docker test image,
network-disabled test container, Playwright journey, Docker runtime image, and
authenticated runtime smoke all passed. The final receipt was
`VERIFY-REBUILD: PASS (phase 2, committed checkout, Docker runtime smoke)`.
The ephemeral smoke token was supplied through the process environment and was
not written to the repository.

The native evidence actually produced in this work is indexed in
`docs/evidence/phase2/INDEX.md`:

- `corepack pnpm run test` — PASS: 59 root and 230 workspace tests passed; one
  Windows-only POSIX process-tree qualification test skipped.
- `corepack pnpm run typecheck` — PASS.
- `node scripts/catalog-lint.mjs --json` — PASS: 5 records, 6872 bytes, no warnings.
- `corepack pnpm run forge-demo` — PASS: mock consult, exploration artifact,
  3-record verified Ledger chain.
- `corepack pnpm run test:e2e` — PASS: one native Playwright test.

For a future clean committed checkout, rerun the exact command:

```sh
LP_SMOKE_TOKEN=<ephemeral-token> bash scripts/verify-rebuild.sh 2
```

Real provider/model, hosted-vendor, GPU, and Owner-hardware runs are also not
represented by this receipt.
