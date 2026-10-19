# ADR-0012 — Keychain and environment secret boundary

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Provider keys must not enter project files, logs, prompts, or git history.

## Options considered

- OS keychain for GUI and `LP_*` environment variables for headless CI.
- Plaintext project configuration.
- A hosted secret manager in the local-only product.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 012. Keychain library selection is a later research item.

## Decision

Use an OS keychain abstraction for GUI-managed keys and environment variables for explicit headless runs. Redact secret values at logging and error boundaries.

## Consequences

Headless operation remains possible without writing keys. Linux secret-service behavior and fallback policy require qualification.

## How to revert

Any alternative must preserve no-secrets-in-files/logs and be reviewed in a security ADR with platform evidence.
