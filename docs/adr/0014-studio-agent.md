# ADR-0014 — Thin Studio Agent runtime

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Standalone Mode B needs reasoning while Mode A must not gain a second orchestrator.

## Options considered

- A thin in-house loop on top of provider adapters, compared later with an MIT/Apache library.
- A framework that owns the Core API and policy.
- A second product with separate tools.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 014. The comparison spike is explicitly deferred to Phase 9.

## Decision

The Studio Agent is a client of the Core API and is used only in Mode B. Phase 9 will time-box an in-house versus permissive-library comparison.

## Consequences

Both modes share tools and evidence. Agent-loop choices cannot silently alter Core authority or approvals.

## How to revert

Use the Phase 9 spike evidence to supersede this ADR while retaining Core-client parity.
