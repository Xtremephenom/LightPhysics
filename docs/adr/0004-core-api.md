# ADR-0004 — One schema-first Core API

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Both reasoning modes must reach the same capabilities and policy boundaries.

## Options considered

- One JSON-RPC Core API over HTTP and WebSocket with MCP, CLI, and GUI facades.
- Separate APIs per client.
- A custom wire protocol.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2 and §5, ADR 004. MCP version details are still a research item.

## Decision

Use one schema-first Core API, with Zod-derived contracts when the schemas package is created. Use JSON-RPC 2.0 over HTTP and WebSocket.

## Consequences

Facades stay thin and parity is testable. API schemas and error taxonomy become compatibility contracts.

## How to revert

Demonstrate a required behavior that cannot be expressed by the API and write a superseding ADR before adding a second protocol.
