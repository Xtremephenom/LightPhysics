# Third-party notices

Phase 2 keeps the Forge/catalog implementation dependency-light: it uses the existing lockfile-managed TypeScript graph and deterministic fixtures, with no model weights, Python worker environment, hosted provider SDK, or provider key in the repository. The project license is MIT in `LICENSE` and ADR-0018; third-party dependency/tool/model review remains separate and is not commercial clearance.

## Build inputs

| Input | Source | Version/digest | Status | Notice |
| --- | --- | --- | --- | --- |
| Node Docker base | Docker registry manifest for `node:24.18.0-bookworm-slim` | `sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6` (linux/amd64) | Recorded for the bootstrap | The image's own license and notices remain part of the upstream image. |
| Node runtime | `.node-version` | `24.18.0` | Pinned by project requirement | Distribution and license notices are supplied by the selected Node installation. |
| TypeScript | root `devDependencies` | `5.9.3` | Exact and lockfile-managed | Review the upstream license before a distributable release. |
| Vitest | root `devDependencies` and existing package manifests | `2.1.9` | Exact at root; lockfile-managed | Review the upstream license before a distributable release. |
| `@types/node` | root `devDependencies` and existing package manifests | `22.20.5` | Exact at root; type-only dependency | Review the upstream license before a distributable release. |
| zod | existing package manifests | `3.25.76` | Lockfile-managed | Review the upstream license before a distributable release. |
| ws | `apps/lpd/package.json` | `8.22.0` | Exact runtime dependency; [R-002] | Registry metadata reports MIT; refresh the notice from the upstream license text before distribution. |
| @types/ws | `apps/lpd/package.json` | `8.18.2` | Exact type-only dependency; [R-003] | Registry metadata reports MIT; development-only. |
| @playwright/test | root `devDependencies` | `1.64.1` | Exact browser-test dependency; [R-005] | Registry metadata reports Apache-2.0; browser binaries are installed separately and are not committed. |
| playwright / playwright-core | transitive dependency of `@playwright/test` | `1.64.1` | Exact lockfile entries; [R-005] | Review upstream notices before distribution; used only by opt-in browser tests. |
| pnpm | `package.json#packageManager` | `12.14.0` | Pinned project tool | Add the upstream notice when pnpm is vendored or distributed. |
| Forge/catalog fixtures | `packages/forge/`, `catalog/` | Phase 2 mock/fixture code and records | Offline tests only | No external model weights or provider SDKs; records are explicitly not real-model qualification. |
| uv, Godot, Blender | `tools.lock.json` | Scoped pinned profiles | Windows x64/Linux x64 Docker smokes recorded | These runtime/tool claims remain limited to their evidence receipts; review upstream notices before distribution. |
| ffmpeg | `tools.lock.json`, R-013 | `9.0.2`, `n9.0.2-28-g669f5ab083`, LGPL static | Windows x64 and Linux x64 Docker version/lavfi smokes recorded | BtbN's LGPL static build is used only as a pinned subprocess artifact; FFmpeg upstream terms and codec obligations do not choose the LightPhysics project license. |

No third-party source text or executable is copied into this bootstrap. Each later dependency must add its license, source URL, exact version, checksum where applicable, and any required notices before adoption.
