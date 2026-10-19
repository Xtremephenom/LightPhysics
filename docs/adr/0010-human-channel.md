# ADR-0010 — Human-only approvals

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Agents must not approve their own creative work, quality exceptions, or releases.

## Options considered

- A Human Channel with device-key-signed approvals, separate from agent facades.
- Approval methods exposed through MCP or CLI.
- A boolean flag in a project file.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 010. The signed channel and negative matrix are Phase 1 work.

## Decision

Only the Human Channel can produce approval evidence. Agent-facing interfaces may request and inspect approvals but cannot grant them.

## Consequences

Approval flows need a separate authority boundary, nonce/replay protection, and auditable evidence.

## Electron boundary note

The Electron main process owns the safeStorage-backed key-store seam and the
native enrollment confirmation. `apps/electron/src/human-channel-listener.mjs`
accepts an injected `createWardenAdapter` because the JavaScript Electron entry
point does not import the TypeScript Warden package directly. Its bootstrap
result is explicitly `qualified: false` until a packaged adapter is supplied;
the listener remains private to main and returns only bounded public status or
verified receipts. No preload, IPC, HTTP, or CLI approval route is created.

## How to revert

This foundational decision is not changed for convenience. A demonstrated security contradiction requires a security ADR and Owner review.
