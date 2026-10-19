# Phase 0 Godot fixture smoke boundary

## Required offline result

```text
node --test tests/godot-smoke.test.mjs
5 passed
```

The deterministic tests verify the exact headless argument vectors, executable-resolution precedence, bounded-run options, boot-marker classification, valid/invalid `--check-only` classification, optional `--import` argument construction and `import-success` exit-code classification, and the typed `GODOT_NOT_FOUND` path. The fixture contains a minimal project, a boot script, a valid syntax-check script, and an intentionally invalid negative fixture.

## Actual engine status

The default opt-in command is:

```sh
node scripts/godot-smoke.mjs --godot <installed-godot-executable>
```

The optional headless project-import mode is:

```sh
node scripts/godot-smoke.mjs --godot <temporary-path> --import --timeout-ms 30000
```

With `--import`, the runner validates the same fixture and invokes one direct
child process equivalent to `--headless --path <fixture> --import --quit`.
It does not run the boot/check-only suite or require the boot marker; exit code
0 is classified as `import-success` with the message `headless import exited 0`.

The pinned Godot 4.7.2 Windows x64 editor archive was installed into an external temporary directory by the committed hash-checked installer after the ZIP parser accepted its method-8 `0x0002` compression-option flags. The direct committed runner then passed headless boot→quit with `LIGHTPHYSICS_GODOT_SMOKE_PASS`, valid `--check-only` exit 0, and invalid `--check-only` exit 1 under a 30-second per-command timeout. The same installer and runner also passed all three modes for the pinned Linux x64 archive inside the Dockerfile's pinned Node base-image container; the installer preserved the archive executable bit. The temporary installations were removed after the redacted results were recorded in `godot-win32.json` and `godot-linux-docker.json`.

The separate redacted `godot-import.json` receipt records the optional `--import` result from commit `26fdb01` for the pinned Godot 4.7.2 Windows x64 and Linux x64 Docker artifacts. Both runs report exit code 0, classification `import-success`, and message `headless import exited 0`; their temporary executable paths are redacted.

These results are limited to the recorded Windows x64 and Linux x64 Docker profiles. The import receipt qualifies only headless project import; it does not qualify a native Linux host, boot/check-only behavior beyond the separate receipts, rendering, gameplay, performance, packaging, export templates, or other Godot versions/profiles.
