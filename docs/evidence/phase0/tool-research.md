# Phase 0 tool research update

## Sources recorded

- **R-006:** uv 0.13.1 release and checksum manifest; x86_64 Linux and Windows artifacts are pinned.
- **R-007:** Godot 4.7.2 stable archive, GitHub release asset digests, and official command-line documentation.
- **R-008:** Blender 5.2.2 LTS page, official archive checksum file, and command-line manual.
- **R-009:** Blender's official GPL/software and artwork licensing page.
- **R-010:** sqlite-vec v0.1.9 release, checksum manifest, README/KNN documentation, and MIT/Apache license texts.
- **R-012:** npm registry package metadata plus Node 24.18.0 `node:sqlite` extension-loading API facts used by the focused spike.

## Scope boundary

These are primary-source release, checksum, license, and API facts recorded on 2026-10-19. The focused Windows x64 run now measures sqlite-vec v0.1.9 through Node's built-in binding; it does not claim Linux qualification. The installer now demonstrates tar.gz parsing and keeps tar.xz conditional on a local xz executable. The remaining unresolved work is ffmpeg pinning, clean Linux/Windows engine runs, tar.xz runtime availability on target profiles, and the separate Linux sqlite-vec result.
