# ADR-0007 — Local generation runtimes behind Forge adapters

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Creative generation has different runtime and hardware requirements from reasoning and must be routed through one policy surface.

## Options considered

- ComfyUI for image-class workflows, llama.cpp server for LLM/VLM/embeddings, and isolated Python workers for other modalities.
- One monolithic generation runtime.
- Direct provider calls from skills and facades.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 007. Runtime versions, flags, licenses, and hardware qualification are UNKNOWN in R-001.

## Decision

Put local and hosted creative routes behind Forge adapters. Prefer the listed local runtimes only after qualification.

## Consequences

Routing, cost, privacy, and qualification remain centralized. No model or runtime may be called qualified from this placeholder.

## How to revert

Use measured qualification or a hard compatibility failure to propose a replacement runtime in a new ADR.
