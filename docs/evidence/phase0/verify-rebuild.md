# Phase 0 committed-state rebuild proof

## Command

```sh
LP_SMOKE_TOKEN=<redacted> bash scripts/verify-rebuild.sh 0
```

## Recorded result

```text
committed state only: PASS
fresh clone: PASS
native dependency install: PASS
offline native hygiene: PASS
Docker test image: PASS
network-disabled test container: PASS (offline suite plus real Studio Floor Playwright test: 1 passed)
Docker runtime image: PASS
authenticated runtime smoke: PASS (Docker-selected loopback host port)
VERIFY-REBUILD: PASS (phase 0, committed checkout, Docker runtime smoke)
```

The proof ran from commit `bbacc39` on the Builder's Windows/Docker Desktop environment. Build-time dependency installation used the network to fetch the lockfile-managed packages, the pinned FFmpeg Linux artifact, and Playwright Chromium revision `1248`; the test container ran with `--network none` and used the preinstalled browser as the non-root `lp` user. The smoke token was generated for this local run, supplied through `LP_SMOKE_TOKEN`, and is not recorded. This revision includes the bounded ZIP/tar installer tests, GNU TAR long-name/symlink safety, executable-bit preservation, legitimate architecture-label handling, the pinned FFmpeg install/smoke path, pinned Electron and sqlite-vec workspace packages, the measured Electron shell boundary, method-aware ZIP compatibility, and the redacted Godot headless project-import receipt; the network-disabled test container also reported the qualified sqlite-vec v0.1.9 KNN result on Linux x64.
