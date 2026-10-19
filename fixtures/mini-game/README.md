# Mini-game Godot fixture

This directory is a tiny deterministic Godot 4 project used by the opt-in
Phase 0 smoke runner. It contains no gameplay or external assets:

- `project.godot` is the minimal project configuration.
- `smoke-entry.gd` is the headless boot entrypoint. It prints the stable
  `LIGHTPHYSICS_GODOT_SMOKE_PASS` marker and immediately quits with exit code 0.
- `check-valid.gd` is the syntactically valid `--check-only` fixture.
- `check-invalid.gd` is intentionally parser-invalid. It is used only for the
  negative `--check-only` assertion and must not be treated as a successful boot
  path.

## Opt-in smoke

From the repository root, supply an installed Godot executable explicitly:

```sh
corepack pnpm run test:godot -- --godot /path/to/godot
```

Or set `LP_GODOT`:

```sh
LP_GODOT=/path/to/godot corepack pnpm run test:godot
```

The runner also accepts a project-local executable at
`tools/godot/godot` (or `tools/godot/godot.exe` on Windows), after the explicit
and environment-variable paths. It never downloads or installs Godot and does
not use the network. `make test-godot` is the equivalent opt-in Make target.

The default runner executes three direct child-process commands with bounded
output and a timeout: headless boot/quit with `smoke-entry.gd`, valid script
`--check-only`, and invalid script `--check-only`. The invalid script's
nonzero result is the expected result for that negative case.

The optional `--import` mode replaces that three-command suite with one
headless project import and quit:

```sh
node scripts/godot-smoke.mjs --godot /path/to/godot --import --timeout-ms 30000
```

It invokes Godot with `--headless --path <fixture> --import --quit` and
classifies exit code 0 as `import-success` (`headless import exited 0`). It does
not run the boot-marker or `--check-only` cases. The redacted pinned results for
Windows x64 and Linux x64 Docker are recorded in
`docs/evidence/phase0/godot-import.json`.

These local commands do not by themselves qualify Docker, Linux, Windows, a
Godot release, the GUI, gameplay, rendering, performance, packaging, or any
external engine integration. The separate import receipt is limited to
headless project import on the pinned Windows x64 and Linux x64 Docker profiles;
it does not expand those claims. The normal offline `pnpm run test` command does
not invoke Godot.
