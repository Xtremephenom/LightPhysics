# ADR-0019 — Typed failures for unimplemented capabilities

Status: accepted
Date: 2026-10-19
Phase: 1

## Context

LightPhysics exposes a schema-first Core API whose surface grows across phases. A
declared method or adapter may exist before its implementation is available, but
callers must be able to distinguish that state from a successful result or an
unexpected daemon failure.

## Options considered

- Return a successful placeholder result and let each facade invent its own wording.
- Collapse unavailable capabilities into `Internal` or `NotFound` errors.
- Use one typed `NotImplemented` application error with phase-aware details.

## Evidence

`docs/pack/11_ROADMAP_AND_PHASE_PROMPTS.md` requires unimplemented work to fail
visibly with `NotImplemented{phase}` or `Unqualified`; `docs/pack/10_REPO_AND_REBUILDABILITY.md`
H-15 rejects fake success. The Phase 1 Core API contract tests cover the stable
`NotImplemented` code and JSON-RPC mapping.

## Decision

Use `NotImplemented` as a stable Core error code. The Core API exposes a
`NotImplementedError` class, maps it to the typed JSON-RPC error envelope, and
allows `suggested_next` plus bounded `details` to identify the phase or fallback.
Unimplemented capabilities must not return a successful placeholder.

## Consequences

Clients can branch on a stable typed code without parsing messages, and future
facades can preserve the same failure contract. Callers still need to treat the
details as untrusted data; phase metadata is descriptive rather than a promise
that the capability will be delivered on a particular date.

## How to revert

Only supersede this ADR with a replacement that preserves visible typed failure
semantics and updates the Core schema, facade contracts, and H-15 tests together.
