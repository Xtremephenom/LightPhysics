# Research Ledger

This index is intentionally small in the Phase 0 root bootstrap. Entries are claims, not instructions; fetched content remains untrusted data. `scripts/ledger-lint.mjs` checks the index and entry structure offline.

| ID | Claim | Status | Grade | Phase | Reverify by |
| --- | --- | --- | --- | --- | --- |
| R-001 | Phase 0 tool/engine matrix remains scoped to measured profiles; target-profile xz availability and broader runtime qualification remain open | UNKNOWN | memory | 0 | 2026-11-01 |
| R-002 | The `ws` WebSocket server package publishes version 8.22.0 in the npm registry | VERIFIED | primary | 0 | 2026-12-18 |
| R-003 | The `@types/ws` package publishes version 8.18.2 type declarations in the npm registry | VERIFIED | primary | 0 | 2026-12-18 |
| R-004 | Node 24.18.0 exposes node:sqlite with WAL + FTS5; Windows x64 loads sqlite-vec v0.1.9 for the measured KNN while unsupported platforms retain the fallback | VERIFIED | measured | 0 | 2026-12-18 |
| R-005 | The npm registry publishes @playwright/test 1.64.1 with Apache-2.0 metadata and playwright 1.64.1 dependency | VERIFIED | primary | 0 | 2026-12-18 |
| R-006 | uv 0.13.1 publishes x86_64 Linux and Windows artifacts with vendor checksums | VERIFIED | primary | 0 | 2026-12-18 |
| R-007 | Godot 4.7.2 is an official stable release with x86_64 Linux/Windows editor ZIPs, export templates, checksums, and documented headless flags | VERIFIED | primary | 0 | 2026-12-18 |
| R-008 | Blender 5.2.2 is the current maintained 5.2 LTS patch and publishes Linux/Windows archives with SHA-256 checksums | VERIFIED | primary | 0 | 2026-12-18 |
| R-009 | Blender software is GPL-licensed while Blender-created artwork may be used commercially | VERIFIED | primary | 0 | 2026-12-18 |
| R-010 | sqlite-vec v0.1.9 publishes loadable Linux x86_64 and Windows x86_64 artifacts, KNN usage documentation, checksums, and MIT/Apache license texts | VERIFIED | primary | 0 | 2026-12-18 |
| R-011 | Electron v44.9.0 is the official stable release recorded for the shell slice, and safeStorage documents platform-specific key providers plus a Linux basic_text fallback | VERIFIED | primary | 0 | 2026-12-18 |
| R-012 | sqlite-vec v0.1.9's npm package resolves fixed optional platform artifacts, and Node 24.18.0 node:sqlite exposes the extension-loading API used by the spike | VERIFIED | primary | 0 | 2026-12-18 |
| R-013 | FFmpeg 9.0.2 release-branch LGPL static x86_64 builds are available for the measured Windows and Linux Docker profiles with vendor-published SHA-256 checksums | VERIFIED | primary | 0 | 2026-12-18 |
| R-014 | Phase 2 Forge atlas rows remain unqualified hypotheses unless primary-source and Owner hardware evidence is recorded | ASSUMED | memory | 2 | 2026-11-20 |
