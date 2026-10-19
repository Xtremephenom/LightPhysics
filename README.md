# LightPhysics

LightPhysics is a native-AI game studio with one local daemon, a shared Core API, an external-agent mode, and a standalone GUI mode. The Phase 0 walking skeleton now includes schema-first contracts, a typed dispatcher, a loopback-safe authenticated daemon, and cross-platform `lpd`/`lp` workspace wrappers. The current Phase 1 kernel implementation adds Ledger, Warden, Runner recovery, project Memory, and an Electron-main Human Channel boundary.

## Status

| Area | Current status |
| --- | --- |
| Repository and pins | Bootstrap files present; Node 24.18.0 and pnpm 12.14.0 are pinned |
| Offline test command | Available: `pnpm run test` (hygiene, SQLite/FTS5, GUI-resource smoke, strict typechecks, workspace contracts, footprint tests, and bootstrap tests) |
| Docker | Four-stage image starts the authenticated `lpd` runtime and installs the pinned FFmpeg 9.0.2 LGPL static artifact during the network-enabled base stage |
| Application | `lpd` HTTP/WebSocket server, `lp` handlers, browser-served Studio Floor shell, local and Docker Playwright browser smokes, and an opt-in Electron shell smoke are runnable; packaging remains open |
| Phase 1 kernel | Formally closed with tested and rebuild-verified implementation surfaces; Owner confirmation, packaging, non-Windows safeStorage, and hardware footprint qualification remain explicitly deferred or unqualified |
| Engine fixtures | Pinned Godot 4.7.2 fixture boot/check-only smoke and optional headless project-import evidence are recorded for Windows x64 and Linux x64 Docker; broader engine qualification remains open |

Phase 1 is formally closed for the implemented surfaces. Its implementation
criteria are evidenced in
[BUILD_STATE](docs/BUILD_STATE.md), the [evidence index](docs/evidence/phase1/INDEX.md),
and [the kernel rebuild receipt](docs/evidence/phase1/verify-rebuild.md). The
remaining deferred limits are Owner interaction, packaging/distribution,
non-Windows safeStorage profiles, and hardware footprint qualification.

## Setup

Prerequisites are Git, Node **24.18.0**, Corepack, pnpm **12.14.0**, and Python **3.12.0** for later worker phases. Docker is optional for the native bootstrap test and required for a rebuild proof. On Windows, use a native Node install or WSL; do not copy machine-specific paths into repository files.

```sh
corepack enable
corepack prepare pnpm@12.14.0 --activate
pnpm install --frozen-lockfile
```

The root runtime graph is intentionally small: pinned TypeScript, Vitest, Node type declarations, and the pinned `sqlite-vec` v0.1.9 package support the strict workspace and database checks. Existing package dependencies are resolved in the same lockfile; adding a dependency later must not silently change that graph. `sqlite-vec` platform artifacts are optional package dependencies, so an unsupported host remains visible as an explicit vector fallback.

The Electron package is pinned to **44.9.0** in `apps/electron/package.json` and
`pnpm-lock.yaml`. Electron 44 keeps its platform executable as a separate
download, so provision that executable explicitly when you intend to run the
desktop shell or its opt-in smoke:

```sh
corepack pnpm --filter @lightphysics/electron exec install-electron
```

This setup command downloads only the pinned project dependency into the local
package install. `pnpm run test` never provisions Electron, and
`pnpm run test:electron` never downloads or installs it; the smoke fails
visibly with an actionable `ELECTRON_NOT_FOUND` result when the executable is
absent.

## Run and test

The one offline test command runs the Phase 0 hygiene checks plus the current Phase 1 SQLite/FTS5, Warden, Runner, Memory, lpd, GUI-boundary, and TypeScript workspace tests. It needs no Docker, network, GPU, provider key, or installed engine.

```sh
pnpm run test
```

The Phase 0 GUI prerequisite smoke can also be run directly:

```sh
corepack pnpm run gui-smoke
```

`gui-smoke` launches the existing `lpd` wrapper with a test token held only in the child process environment and a kernel-assigned loopback port, fetches `/`, `/app.js`, and `/styles.css` over HTTP, checks the visible Studio Floor/status-bar markers, the strict local CSP, and the absence of remote resource URLs, then checks both rejected and authenticated `system.info` requests. It is a browser-resource smoke prerequisite. It does not execute JavaScript in a browser, render or inspect DOM/layout, exercise the token form in a browser, run accessibility or visual checks, test browser WebSockets, package Electron, or provide Playwright coverage.

### Electron shell smoke (opt-in)

The focused `apps/electron/` package is a minimal plain-ESM main/preload
shell around the existing lpd-served Studio Floor. The main process loads only
a validated literal loopback `LP_GUI_URL` (or an opt-in smoke/footprint URL argument),
uses `contextIsolation: true`, `nodeIntegration: false`, and a sandboxed
renderer, and denies external navigation/new windows. The preload bridge
exposes only bounded Human Channel status and native enrollment requests; it
does not expose tokens, environment variables, filesystem access, signers,
signatures, approvals, or arbitrary IPC.

Run the shell against a separately started authenticated daemon:

```sh
# terminal 1
LP_TOKEN=<local-runtime-token> corepack pnpm run lpd

# terminal 2
LP_GUI_URL=http://127.0.0.1:4317/ corepack pnpm --filter @lightphysics/electron start
```

The opt-in smoke owns both processes and uses an ephemeral loopback port for
`lpd`:

```sh
corepack pnpm run test:electron
corepack pnpm run test:electron-human-channel
corepack pnpm run test:e2e
make test-electron
```

It uses direct child-process arguments with `shell:false`, bounded output and
timeouts, starts the authenticated daemon, launches the already-installed
Electron 44.9.0 executable with a validated `--smoke-url`, waits for the real
renderer to load, then verifies the Studio Floor title, stable selectors and
status-bar text, same-origin/loopback location, and the exact local CSP. The
Electron child receives no `LP_TOKEN`. Both children are shut down in cleanup.
The smoke is deliberately separate from `pnpm run test` and fails visibly when
Electron or display support is unavailable; it never downloads Electron.

### Electron idle footprint (opt-in)

The Electron footprint command owns an authenticated `lpd` child and launches
the already-provisioned pinned Electron 44.9.0 executable with a validated
`--footprint-url`. It waits for the real Studio Floor renderer to pass the same
markers/CSP checks as the smoke, records a bounded cold-start timestamp, then
collects five bounded idle samples from Electron's own
`app.getAppMetrics()` for the main Browser process and Studio Floor renderer
Tab process. Working-set and Windows private-byte aggregates are recorded when
Electron exposes them. Child arguments use `shell:false`; output, timeouts, and
shutdown are bounded; tokens, URLs, paths, PIDs, and page content are omitted
from the report.

```sh
corepack pnpm run measure:electron-footprint -- \
  --output docs/evidence/phase0/footprint-electron-win32.json
make electron-footprint
```

This command is opt-in and is not part of `pnpm run test`; it never installs or
downloads Electron. The recorded Windows host result is a host-specific
measurement only: qualification is `NOT_QUALIFIED` and
`architecture_budget_claimed` is `false`. It does not qualify packaging,
visual/accessibility behavior, Linux secret-store behavior, or memory on other
platforms. A missing Electron executable, display, renderer, or memory source
fails visibly with a typed error.

The local Playwright smoke executes the browser path:

```sh
corepack pnpm exec playwright install chromium
corepack pnpm run test:e2e
```

It tests the real token form, live status updates, authenticated refresh, same-origin requests, and the unauthenticated RPC boundary. The browser binary is installed outside the repository. This native run is not Electron coverage; the Docker browser result is recorded below.

The Docker test stage provisions the exact Chromium revision selected by the
pinned Playwright `1.64.1` package (revision `1248`, Chrome for Testing
`156.0.8078.4`) during the network-enabled dependency build. It stores the
browser at `/opt/ms-playwright`, readable by the non-root `lp` user, and
declares its Debian 12 runtime/font packages in `docker/apt-packages.txt`.
The test container runs the offline suite and then the same real browser
journey with networking disabled:

```sh
corepack pnpm run docker-test
```

This Docker browser result does not require `xvfb-run`; the existing test
launches Chromium headless. It does not claim Electron packaging, Windows
installer coverage, visual snapshots, or accessibility audits.

### Godot fixture smoke (opt-in)

The repository includes a tiny deterministic Godot fixture under
`fixtures/mini-game/`. It is not part of the offline test command. Run the
smoke only when an installed Godot executable is available:

```sh
node scripts/godot-smoke.mjs --godot /path/to/godot
```

To run the optional headless project-import mode instead of the boot/check-only
suite:

```sh
node scripts/godot-smoke.mjs --godot <temporary-path> --import --timeout-ms 30000
```

The runner resolves Godot in this order: an explicit `--godot PATH`, the
`LP_GODOT` environment variable, then the documented project-local path
`tools/godot/godot` (or `tools/godot/godot.exe` on Windows). For example:

```sh
LP_GODOT=/path/to/godot corepack pnpm run test:godot
make test-godot
```

On PowerShell, set the environment variable before invoking the command:

```powershell
$env:LP_GODOT = "C:\path\to\godot.exe"
corepack.cmd pnpm run test:godot
```

The runner does not download or install Godot and does not use the network. It
uses direct child-process arguments with `shell:false`, bounded stdout/stderr,
and a per-command timeout. It checks headless boot→quit plus the stable
success marker, a valid `--check-only` script, and a deliberately invalid
fixture script whose nonzero `--check-only` result is expected. A missing Godot
binary or invalid fixture fails with an actionable typed error.

With `--import`, the runner validates the same fixture and invokes one direct
child process equivalent to `--headless --path <fixture> --import --quit`
instead of the boot/check-only suite. A zero exit is classified as
`import-success` with the message `headless import exited 0`; no boot marker or
syntax-check result is asserted. The redacted
`docs/evidence/phase0/godot-import.json` receipt records that result for the
pinned Godot 4.7.2 Windows x64 and Linux x64 Docker artifacts from commit
`26fdb01`, with the temporary executable paths redacted.

Passing one invocation of either mode proves only the scoped behavior exercised
on that invocation's machine. The import receipt is limited to headless project
import on Windows x64 and Linux x64 Docker; it does not qualify native Linux,
Godot GUI, gameplay, rendering, performance, packaging, export templates, or
other Godot versions/profiles. The deterministic Node tests for argument
construction and result classification run inside the offline suite without
starting Godot; the measured Windows and Linux Docker invocations are recorded
separately below.

The recorded default-mode Windows x64 run used the pinned Godot 4.7.2 editor archive. The
committed installer verified archive SHA-256 before parsing/extraction, accepted
the archive's method-8 `0x0002` compression-option flags, extracted both editor
executables into an external temporary directory, and the direct runner passed
boot→quit plus valid and invalid `--check-only` cases under a 30-second
per-command timeout. A second opt-in run verified the pinned Linux x64 archive
inside the Dockerfile's pinned Node base-image container, preserved its
executable bit, and passed the same three modes. The temporary installations
were removed after recording `docs/evidence/phase0/godot-win32.json` and
`docs/evidence/phase0/godot-linux-docker.json`. The optional import result is
recorded separately in `docs/evidence/phase0/godot-import.json`. The claim is
scoped to these two pinned editor fixture-smoke profiles and the separately
recorded headless project-import result; it does not qualify native Linux,
rendering, gameplay, performance, packaging, export templates, or other
profiles.

Fast mode is equivalent at this phase and is intended for an edit loop:

```sh
pnpm run test:fast
```

The database spike is also runnable directly. It measures the pinned Node runtime's file-backed WAL and FTS5 behavior, then resolves the pinned `sqlite-vec` package through Node's built-in extension boundary. On a supported package/platform it verifies `vec_version() = v0.1.9`, creates a `vec0` table, inserts three deterministic vectors with BigInt rowids, and reports the KNN nearest ID/distance. If the package or platform artifact is unavailable, the result is explicitly `UNQUALIFIED` with `mode: FALLBACK` and a typed reason code:

```sh
corepack pnpm run db-spike
```

The recorded Windows x64 result and the Linux x64 Docker test-container result qualify the v0.1.9 extension and return `north` at distance `0.141421377658844`. Native non-x64 qualification is not claimed; the deterministic fallback and its unsupported-package classification are covered by the offline tests.

The footprint probe is also an explicit measurement, not a qualification claim:

```sh
node scripts/footprint.mjs --output docs/evidence/phase0/footprint-<profile>.json
```

The existing probe measures only the `lpd` child. The Electron-specific report
is `docs/evidence/phase0/footprint-electron-win32.json` and is produced only by
the opt-in command above.

The same commands are available through Make on systems that provide it:

```sh
make setup
make test
make test-fast
make gui-smoke
make test-electron
make electron-footprint
make test-godot
make run
```

The wrappers use Node's built-in TypeScript stripping and can be run from the workspace without a global install:

```sh
corepack pnpm run lpd -- --help
corepack pnpm run lp -- --version
corepack pnpm run lp -- doctor --json
corepack pnpm run lp -- daemon status
LP_TOKEN=... corepack pnpm run lp -- daemon start
corepack pnpm run lp -- daemon stop
```

`lpd` requires `LP_TOKEN` and prints only its non-secret bind/port endpoint. It serves the Phase 0 Studio Floor at `/`, JSON-RPC over HTTP at `/rpc`, and an authenticated JSON-RPC WebSocket at the same path; the browser asks for the token in memory before calling HTTP RPC. `lp daemon start` passes that environment token to the detached daemon and writes only its PID to `${LP_HOME}/run/lpd.pid`; `lp daemon stop` removes the PID file after a clean stop. The token is never written to the PID file. `make run` starts the authenticated daemon and serves the shell.

`lp doctor --json` keeps `tools.node` as the compact Node version string and reports `uv`, `godot`, `blender`, and `ffmpeg` as `{ "status", "version" }` probes. `status` is `available`, `missing`, `unqualified`, `timeout`, or `error`; an unavailable or unqualified optional tool does not make a healthy daemon report `ok: false`. The probes only run fixed local version commands with bounded output/time and never install tools or use the network.

The tool bootstrap guard is available for verified local fixtures:

```sh
node scripts/install-tools.mjs --help
node scripts/install-tools.mjs --tool <name> --platform <platform> --destination <dir> --archive <verified-fixture-archive>
node scripts/install-ffmpeg.mjs --platform win-x64 --destination <dir>
node scripts/ffmpeg-smoke.mjs --ffmpeg <installed-ffmpeg> --timeout-ms 30000
```

It refuses `UNKNOWN` lock entries, requires HTTPS for remote artifacts, follows at most three manually validated HTTPS redirects without credentials, detects archive format from content, checks SHA-256 before decompression, and safely extracts bounded stored/deflated ZIP files (including method-8 compression-option flags) plus regular-file/directory tar.gz archives. Unix executable bits are preserved as safe `0755` files without restoring group/other write bits. Remote response bodies remain size-bounded and each request has a bounded timeout. tar.xz uses only a fixed local `xz` executable when available and fails visibly with `XZ_UNAVAILABLE` otherwise; native tar.xz runtime support remains conditional. The offline tests demonstrate bounded redirect handling, method-aware ZIP flags, executable-bit handling, tar.gz parsing, GNU TAR metadata/symlink safety, and the tar.xz parser through an injected decompressor seam; a separate Windows host fixture run also exercises the real local xz path. FFmpeg 9.0.2 is pinned to the release-tagged BtbN LGPL static artifacts, installed through `scripts/install-ffmpeg.mjs` with larger explicit bounds, and checked by the deterministic version/lavfi smoke. Scoped real Godot Windows/Linux-Docker, uv Windows/Linux-Docker, Blender Windows/Linux-Docker, and FFmpeg Windows/Linux-Docker installs/smokes are recorded in `docs/evidence/phase0/`; native/non-x64 and other runtime claims remain open.

`make setup` is the networked setup step. `env-sync --write` regenerates `.env.example` from the single declared list in `scripts/config.env.json`; `env-sync --check` is part of `make test`.

## Docker rebuild and run

The Dockerfile has `base`, `deps`, `test`, and `runtime` stages. The Node base manifest is pinned by digest. `tools.lock.json` records primary-source pins and SHA-256 values for uv 0.13.1, Godot 4.7.2, Blender 5.2.2, and FFmpeg 9.0.2; the pinned Godot editor fixture smoke is qualified on Windows x64 and Linux x64 Docker, uv has Windows x64 and Linux x64 Docker binary smokes, Blender has Windows x64 and Linux x64 Docker background smokes using the bounded tar.xz extractor, and FFmpeg has Windows x64 and Linux x64 Docker version/lavfi smokes. The network-enabled `base` stage installs FFmpeg through the hash-checked wrapper and `xz-utils`; the network-disabled test/runtime stages reuse that installed static binary and do not use an apt-managed FFmpeg. The bootstrap refuses to install any remaining UNKNOWN entry. The network-enabled `deps` stage installs workspace dependencies and the pinned Playwright Chromium revision into `/opt/ms-playwright`; the `test` stage runs the offline suite and the real E2E suite in its network-disabled container. The `runtime` stage starts the same authenticated `lpd` wrapper used by the workspace, with `LP_IN_CONTAINER=1` and `LP_BIND=0.0.0.0` set in the image. The pinned pnpm runtime is prewarmed for the non-root image user, so daemon startup does not need a registry request. `LP_TOKEN` is never an image build argument, `ENV` value, or copied file.

```sh
corepack pnpm run docker-build
corepack pnpm run docker-test
LP_TOKEN=<smoke-token> corepack pnpm run docker-smoke
LP_TOKEN=<runtime-token> corepack pnpm run docker-run
```

`docker-smoke` requires a non-empty token in `LP_TOKEN` (it also accepts `LP_SMOKE_TOKEN` for a dedicated smoke environment). It starts `lightphysics:runtime` detached, passes the token through Docker's runtime environment reference, waits for the image healthcheck, verifies that unauthenticated `system.info` is rejected, verifies authenticated `system.info`, then stops and removes the container. The smoke token is never printed. By default Docker chooses a free loopback host port (`127.0.0.1:0:4317`); the daemon's wider in-container bind is not a host exposure.

If the default host port is busy, set `LP_SMOKE_PORT` to another host port; the mapping remains loopback-only and the daemon still listens on container port 4317:

```sh
LP_TOKEN=<smoke-token> LP_SMOKE_PORT=4318 corepack pnpm run docker-smoke
```

`docker-run` is the foreground owner run path. Supply `LP_TOKEN`, open `http://127.0.0.1:4317/`, and stop it with Ctrl-C; `--rm` removes the container. Its healthcheck calls the existing `lp doctor --json --quick` wrapper with the runtime token and discards the report, so healthcheck output does not disclose the token. On PowerShell, set the environment before invoking the command:

```powershell
$env:LP_TOKEN = "<runtime-token>"
corepack pnpm run docker-run
```

The lower-level equivalents, when needed, are `docker build --target runtime -t lightphysics:runtime .` and `docker build --target test -t lightphysics:test .`; the test image runs the offline suite followed by the real Playwright browser suite with `--network none`.

For the committed-state rebuild proof on a Docker-capable Linux machine:

```sh
LP_SMOKE_TOKEN=<smoke-token> bash scripts/verify-rebuild.sh 0
```

That proof requires a clean committed checkout. The Docker build and runtime smoke are recorded separately in `docs/BUILD_STATE.md`; `scripts/verify-rebuild.sh` remains the committed-checkout proof.

## Configuration

```sh
cp .env.example .env
```

`.env` is ignored. The authoritative repository configuration list is `scripts/config.env.json`; no provider secret has a default value. The daemon's implemented Phase 0 loader consumes the safe `LP_HOME`, `LP_BIND`, `LP_PORT`, `LP_IN_CONTAINER`, `LP_LOG_LEVEL`, and `LP_LOG_FORMAT` values. Set `LP_TOKEN` explicitly in the process environment for `lpd`, `lp daemon start`, `docker-smoke`, or `docker-run`; it is intentionally absent from `.env.example` and is never persisted by the wrappers or Docker image layers. Later phases add the remaining settings and keychain integration.

## Backup and restore

The Phase 1 Runner recovery slice exposes an offline backup round trip through the
CLI. The destination is explicit and must be outside `LP_HOME`; existing files are
never replaced unless `--overwrite` is supplied.

```sh
lp backup create --destination /path/to/lightphysics-backup --config settings.json --config .env
lp backup verify /path/to/lightphysics-backup --json
lp backup restore --from /path/to/lightphysics-backup --to /path/to/new-lp-home
# If lpd is active, request a bounded graceful shutdown before create/restore:
lp backup create --destination /path/to/lightphysics-backup --quiesce
```

Backups include `db/ledger.sqlite`, `db/runner.sqlite`, and regular files under
`store/sha256` by default. Config files are opt-in, resolved relative to `LP_HOME`,
and written in redacted form; secret-like filenames such as `.env` are omitted.
Restore always requires an explicit destination and verifies the manifest and every
file hash before writing. The offline CLI tests use temporary Ledger/Runner
databases, CAS objects, and config fixtures; they do not mutate a repository or the
machine's real `LP_HOME`. Create and restore refuse to run while the configured
`LP_HOME/run/lpd.pid` points to a live daemon unless `--quiesce` is supplied. With
`--quiesce`, the CLI sends one bounded graceful shutdown request, waits up to five
seconds for the PID to exit, removes the stale PID file, and then performs the
backup; it does not restart lpd. A timeout or failed shutdown remains a visible
typed error.

Use `lp backup --help` for `--no-ledger`, `--no-runner`, `--no-cas`, `--quiesce`,
repeated `--config`, JSON output, and restore/verification options.

## Project memory

Phase 1's project-memory path keeps the game repository as the source of truth
and rebuilds its local SQLite/FTS5 index from those files:

```sh
lp init /path/to/my-game
lp project reindex /path/to/my-game
lp resume /path/to/my-game
```

`lp resume` is bounded to the documented 2,500-token brief and includes the
stage, quality-bar gaps, active work orders, pending human decisions, stale
evidence, spend, readiness, and next actions. The authenticated daemon exposes
the same read-only `project.resume` method and the idempotent mutating
`project.reindex` method for the Studio Floor; start `lpd` from the game
repository (or pass `projectRoot` when embedding the server) so the daemon sees
the intended files.

## Connect an agent

The future command is `lp connect claude-code|codex|cursor|gemini-cli|generic`. It will preview a non-destructive configuration diff, create a backup, and support `--undo`. Connect writers are not implemented and no agent configuration is changed by this repository.

## Opt-in suites

`pnpm run test:godot` is an opt-in local fixture smoke and is not part of the offline test command; it requires a user-supplied Godot executable and never installs one. `pnpm run test:electron`, `pnpm run test:electron-human-channel`, and `pnpm run measure:electron-footprint` are also opt-in, require the separately provisioned pinned Electron executable and a display session, and are not part of the offline test command. The footprint result is a measurement only and remains `NOT_QUALIFIED`. `pnpm run test:live`, `pnpm run test:hw`, and `node scripts/win-smoke.mjs` are reserved for later phases. They are not part of the offline test command and must never be reported as run until they produce evidence on the required external agent, hardware, or Windows machine. `test:e2e` is a local browser suite; it requires an installed Playwright browser and is separate from the offline `make test` contract. Docker browser execution is covered by `docker-test`; Electron packaging, Windows packaging/installer coverage, visual, accessibility, Linux secret-store behavior, and cross-platform memory remain unqualified or unrun.

## Deploy

There is no packaged desktop release yet. The supported Phase 0/1 run paths are the native authenticated daemon plus its loopback browser shell, the opt-in Electron shell and Human Channel smokes, and the Docker runtime image with a runtime-supplied token. The Docker image is suitable for the authenticated service smoke, not a production release artifact. Running the Electron shell smoke or footprint measurement does not prove Electron packaging, Docker browser packaging, Windows installer coverage, or a distributable desktop artifact; those claims require separate packaging evidence after an opt-in run on a machine with the pinned Electron package and display support.

## Windows notes

Use the exact versions in `.node-version` and `.python-version`. Keep long-path support enabled if a later game repository needs it. The hygiene scripts are Node programs and do not depend on Bash. `scripts/verify-rebuild.sh` is the one intentional Bash-only command; run it in WSL or a Linux builder. `node scripts/win-smoke.mjs` is reserved for a later phase.

## Layout

`apps/` and `packages/` will contain the application workspace. `scripts/` contains cross-platform hygiene checks. `docker/` contains the audited package list and hash-checked tool-bootstrap skeleton. `docs/adr/` records architecture decisions, `docs/research/` records external facts, and `fixtures/` holds small deterministic fixtures.

## Troubleshooting

- If `pnpm install --frozen-lockfile` reports a lockfile change, stop and inspect `package.json` and `pnpm-lock.yaml`; do not delete the lockfile.
- If `env-sync` reports drift, run `node scripts/env-sync.mjs --write`, review the generated diff, and rerun `node scripts/env-sync.mjs --check`.
- If `path-scan` or `secret-scan` reports a hit, remove the value or record a narrowly scoped fixture exception before continuing.
- `lp daemon start` reports a typed `MissingToken` error when `LP_TOKEN` is absent. Set the token in the invoking environment and retry; it is not read from or written to the PID file.
- `docker-smoke` and `docker-run` fail before starting Docker when `LP_TOKEN` is absent. If the smoke cannot reach `127.0.0.1:4317`, check for another process using that host port and ensure `lightphysics:runtime` was built.

## Security and honest limits

Conditional tar.xz availability outside the measured profile, native Linux and cross-profile engine/runtime qualification beyond the measured Godot/uv/Blender/FFmpeg profiles, provider behavior, and final project-license details remain explicitly open. The pinned Godot Windows x64/Linux x64 Docker fixture and headless project-import smokes, uv Windows/Linux x64 Docker, Blender Windows/Linux x64 Docker smokes, and FFmpeg Windows/Linux x64 Docker smokes passed, but each claim is limited to its recorded profile and command. The repository chooses a safe fallback: no tool installer runs for an unknown lock entry, no secrets are placed in files or image layers, and no production success is simulated. Passing the offline bootstrap and Docker runtime smoke proves the authenticated Phase 0 daemon path only; it does not prove an engine on other profiles, model, external agent, GPU, Windows package, or game-quality result.

## Licensing and third-party notices

The project license is MIT, recorded in `LICENSE` and ADR-0018. Third-party tools and dependencies retain their own licenses and attribution requirements; see `docs/licensing.md` and `THIRD_PARTY.md`. This repository is not legal advice; obtain counsel before a commercial release.

## Contributing and builder protocol

Read `docs/BUILD_STATE.md` first, then the relevant phase section in `docs/pack/11_ROADMAP_AND_PHASE_PROMPTS.md`. Research claims belong in `docs/research/entries/`, decisions belong in `docs/adr/`, and a phase is not complete without its evidence. Do not add fake-success stubs; unimplemented behavior must fail visibly.
