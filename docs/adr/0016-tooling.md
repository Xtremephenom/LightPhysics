# ADR-0016 — pnpm workspace and one linter

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Multiple TypeScript packages need deterministic installs, one style/lint configuration, and a single offline test entry point.

## Options considered

- pnpm workspaces, strict TypeScript, Vitest-compatible config, and Biome.
- Multiple package managers and linter configurations.
- Unpinned ad hoc scripts.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 016. The root keeps its runtime surface small; the current TypeScript/test dependencies are lockfile-managed and the license review remains explicit.

## Decision

Use pnpm workspaces, exact versions, strict TypeScript settings, a Vitest-compatible config, and one Biome configuration. `make test` delegates to the package test script.

## Consequences

Windows can run the Node hygiene scripts directly, while Make remains a thin Unix-friendly wrapper. Adding a second linter requires an ADR.

## How to revert

Measure a hard tooling limitation, record it, and replace the affected configuration in one documented migration.
