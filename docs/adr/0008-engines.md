# ADR-0008 — Godot and Blender engine boundary

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

The product must place validated assets into a real game engine while keeping GPL tooling boundaries explicit.

## Options considered

- Pin Godot 4.x and Blender LTS, with thin bridges and separate processes.
- Embed an engine into the daemon.
- Adopt an external MCP bridge before qualification.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 008. Exact versions, flags, checksums, and bridge qualification remain UNKNOWN in R-001.

## Decision

Use Godot 4.x and Blender LTS through thin headless/live bridges. Run GPL tools as separate processes and qualify any community bridge before adoption.

## Consequences

Engine control is testable and isolated. A small fixture and verified binaries are required before claiming engine support.

## How to revert

Record a measured bridge or engine failure and supersede this ADR with the affected platform and evidence.
