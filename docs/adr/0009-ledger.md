# ADR-0009 — Append-only hash-chained Ledger

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Artifacts, provenance, evidence, approvals, and audits need tamper-evident history tied to builds.

## Options considered

- An append-only, hash-chained SQLite Ledger.
- Mutable logs without integrity checks.
- A hosted audit service.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2 and §6, ADR 009. The implementation and tamper tests belong to Phase 1.

## Decision

Store Ledger records append-only with a hash chain. Evidence binds to a build id; the database remains rebuildable where the architecture allows.

## Consequences

Tampering is detectable and evidence can be invalidated when its subject changes. Canonical serialization and migration details must be tested.

## How to revert

Only a measured integrity or rebuild failure may justify a new evidence-store ADR; preserve the old records during migration.
