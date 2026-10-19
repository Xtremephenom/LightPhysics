# ADR-0017 — Database binding and vector extension

Status: proposed
Date: 2026-10-18
Phase: 0

## Context

The architecture calls for SQLite WAL, FTS5, and a vector retrieval path on Linux and Windows. The Phase 0 spike exercises the pinned Node runtime directly and loads sqlite-vec on the recorded Windows x64 profile and the Linux x64 Docker test container; native non-x64 behavior and the final license boundary remain open.

## Options considered

- Node's built-in `node:sqlite` binding with FTS5 and an extension boundary.
- A Node SQLite binding with built-in or separately loaded FTS5 and sqlite-vec.
- A maintained prebuilt binding with extension loading and Windows artifacts.
- SQLite FTS5 first, with a deterministic brute-force vector fallback behind one interface.

## Evidence

The measured Phase 0 runs are recorded in `docs/evidence/phase0/db-spike.json` and [R-004]. They prove file-backed WAL, FTS5, and sqlite-vec v0.1.9 extension load plus a deterministic three-vector KNN on Windows x64 and in the Linux x64 Docker test container with Node 24.18.0. They do not prove native Linux host behavior, unsupported-platform package availability beyond the tested fallback seam, concurrency, or performance.

## Decision

Propose `node:sqlite` as the Phase 1 storage binding, behind a small interface. Keep FTS5 enabled and retain the deterministic brute-force vector fallback on unsupported platforms. The ADR remains proposed until the remaining license-boundary check is complete.

## Consequences

The root dev dependency pins the sqlite-vec npm package for the spike; production storage remains behind an interface. The fallback must remain capability-visible, and this Windows-only result must not be presented as Linux qualification.

## How to revert

After the spike, replace this proposed ADR with an accepted decision or add a superseding ADR naming the tested binding, exact version, platform artifacts, license, and fallback behavior.
