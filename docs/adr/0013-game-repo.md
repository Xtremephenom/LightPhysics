# ADR-0013 — Git-backed game repositories

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Project Bible, decisions, boards, quality bars, and promoted assets must remain inspectable and rebuildable.

## Options considered

- Git-backed game repositories with optional Git LFS configuration for game binaries.
- Database-only project state.
- A hosted project store.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2 and §6, ADR 013. Game repository creation is Phase 1 work.

## Decision

Files in the game repository are the human-readable source of truth. Only promoted artifacts enter the repo; exploration remains in local CAS.

## Consequences

Reindexing can rebuild derived state and safe points can use git. Binary handling must remain deliberate and platform-safe.

## How to revert

Any change must demonstrate equal or better rebuildability and preserve an exportable file-based source of truth.
