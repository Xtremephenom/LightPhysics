# ADR-0015 — Multi-stage Docker rebuild

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Linux rebuilds need a repeatable, GPU-free test image and a small non-root runtime image.

## Options considered

- `base`, `deps`, `test`, and `runtime` Docker stages with software rendering only when verified.
- A single mutable image.
- A GPU-required image for tests.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 015 and the Phase 0 Docker contract. The bootstrap base digest is recorded; Docker execution evidence is not run in this session.

## Decision

Use multi-stage Docker with a digest-pinned Node base, a dependency cache stage, an offline test stage, and a non-root runtime stage. Do not require a GPU for tests.

## Consequences

Build and test layers are separable and runtime contents can be reduced. Exact apt/tool packages must be verified before engine claims are made.

## How to revert

Only measured rebuild or security evidence may supersede this ADR; retain the one-command offline test contract.
