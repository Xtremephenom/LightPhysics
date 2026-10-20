# ADR-0020 — Forge adapters, catalog, and offline qualification boundary

Status: accepted
Date: 2026-10-20
Phase: 2

## Context

Phase 2 needs one normalized creative capability surface for local, hosted, and
fixture providers without making a real model claim in an offline build. The
reference environment has no GPU or hosted credentials, so adapters must be
injectable, failures must map to stable typed errors, and catalog records must
make license, hardware, qualification, privacy, and cost state visible.

## Options considered

- Let each provider expose its own request and response shape.
- Add provider SDKs and model weights to the repository.
- Use normalized capability requests, injected adapters, deterministic mock
  fixtures, a bounded JSON catalog, and explicit qualification records.

## Evidence

- `packages/forge/src/` contains the normalized capability taxonomy, adapter
  contracts, mock failure injection, HTTP/ComfyUI/Python-worker seams, routing,
  spend, hardware, perception, Style Lock, acquisition, and qualification
  tests.
- `catalog/` and `scripts/catalog-lint.mjs` pass offline with five fixture
  records; unknown licenses are treated as non-commercial.
- `apps/lpd/src/forge-runtime.ts` and `apps/lpd/src/index.test.ts` exercise
  `forge.create` through in-process and HTTP clients, privacy blocking,
  provider failure mapping, Warden authorization, Ledger provenance, and
  idempotent replay.
- `docs/research/model-atlas-verified.md` records the current atlas as
  conservative `ASSUMED`/`DISPROVED` research, not real-model qualification.

## Decision

Use normalized Forge capability schemas and an adapter interface with
`describe`, `health`, `estimate`, `run`, and `qualify`. Keep transport and child
process effects behind injected seams. Use the offline mock adapter and fixture
catalog for deterministic tests. Route hosted calls only when `data_policy`
allows them, record egress as request hash plus provider, require spend
estimation before confirmation, and record exploration artifacts with digest-only
provenance in the Ledger. A model is not `QUALIFIED` without a labeled run.

## Consequences

Agents and future facades can depend on one stable creative contract and typed
failure taxonomy. The current demo proves machinery, not creative quality. Real
provider SDKs, model weights, hosted API contracts, GPU labels, and cost data
must be added only with new research and qualification evidence.

## How to revert

Supersede this ADR with a decision that preserves normalized requests, typed
failures, privacy/egress records, explicit qualification status, and the
offline/mock fallback; update the Forge schemas, catalog lint, runtime tests,
and Phase 2 evidence together.
