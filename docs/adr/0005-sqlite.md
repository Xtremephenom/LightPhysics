# ADR-0005 — SQLite as the local state store

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Indexes, journals, and the Ledger need a portable local store while human-readable project files remain the source of truth.

## Options considered

- SQLite with WAL, FTS5, and a vector extension behind an interface.
- A server database.
- A bespoke file or vector database.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 005. Binding loadability and sqlite-vec compatibility are unresolved in R-001 and ADR-0017.

## Decision

Use SQLite with WAL and FTS5, with vector retrieval behind a replaceable interface. Rebuild the database from files and the artifact store.

## Consequences

No database service is required. The binding and extension must be qualified on Linux and Windows before use.

## How to revert

Run the Phase 0 database spike, record a hard incompatibility, and supersede this ADR with the smallest compatible store choice.
