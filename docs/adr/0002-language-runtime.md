# ADR-0002 — TypeScript and isolated Python workers

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

Core, GUI, CLI, and MCP surfaces need shared types while ML and analysis tooling may need Python.

## Options considered

- Strict TypeScript on Node for the product, with isolated Python workers.
- TypeScript plus Rust for native bindings.
- A Python-first application.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 002. Runtime/tool research remains tracked by R-001.

## Decision

Use strict TypeScript/Node for core, GUI, CLI, and MCP. Use Python only for isolated workers, each with its own uv lock. Do not add Rust by default.

## Consequences

Shared TypeScript contracts are straightforward. Native or ML requirements must cross an explicit worker boundary.

## How to revert

Run a Phase 0 spike against a hard requirement, record evidence in the Ledger, and add a superseding ADR before changing the language boundary.
