# ADR-0006 — Agent Skills open format

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

The skill library must be usable by multiple external agents and by the Studio Agent.

## Options considered

- Agent Skills folders with `SKILL.md`, references, assets, scripts, and LightPhysics metadata.
- One proprietary skill format.
- Per-agent copies with no shared source.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 006. The current Agent Skills specification is a Phase 4 verification item.

## Decision

Use the Agent Skills open folder format and mirror one library to supported agent-native folders by copying, never symlinking.

## Consequences

Skills can be shared and linted. Loader differences and spec drift require a later Ledger entry and validator.

## How to revert

If the verified specification cannot express required metadata, add a converter or superseding ADR rather than silently forking the library.
