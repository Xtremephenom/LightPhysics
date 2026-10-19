# ADR-0003 — Electron shell with React and Vite

Status: accepted (pre-decided)
Date: 2026-10-18
Phase: 0

## Context

The desktop GUI must share a web renderer with a headless browser test surface.

## Options considered

- Electron main process with a React/Vite/TypeScript renderer.
- Tauri with Rust and WebKitGTK.
- A browser-only application.

## Evidence

Pre-decided in `docs/pack/03_ARCHITECTURE.md` §2, ADR 003. The un-packaged shell and browser-sharing path are implemented. The opt-in Windows footprint report in `docs/evidence/phase0/footprint-electron-win32.json` records a 369.748 ms renderer-ready cold start and 186,508,902-byte mean combined working set across five idle samples; it explicitly remains `NOT_QUALIFIED`. Windows packaging, installer behavior, visual/accessibility coverage, Linux secret-store behavior, and cross-platform memory are not measured.

## Decision

Use Electron plus React, Vite, and TypeScript. Serve the renderer from `lpd` as a normal web app for Playwright.

## Consequences

Playwright and desktop behavior can share the renderer. The measured spike supplies a host-specific cost observation without changing the ≤400 MB GUI budget into a qualification claim. The current renderer is still a static browser shell; the planned React/Vite migration, packaging, and distribution work remain open.

## How to revert

Record measured memory or packaging failure, then supersede this ADR with evidence and a migration path.
