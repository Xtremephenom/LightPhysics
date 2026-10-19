# ADR-0001 — Single local daemon

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

LightPhysics needs one source of state and policy for the external-agent and standalone modes.

## Options considered

- A single local daemon owns state and logic.
- Separate logic in the GUI, CLI, and agent facades.
- A hosted coordination service.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 001. No implementation evidence is claimed in the root bootstrap.

## Decision

Use one local `lpd` daemon. GUI, CLI, MCP, and Studio Agent are clients.

## Consequences

There is one place for permissions, jobs, evidence, and state. The daemon becomes a foundational dependency and must remain observable.

## How to revert

Only a measured Phase 0+ spike showing a hard requirement cannot be met may supersede this ADR with a new ADR and migration plan.
