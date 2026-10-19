# Phase 0 footprint measurement

## Command

```sh
node scripts/footprint.mjs --output docs/evidence/phase0/footprint-win32.json
```

## Recorded result

The machine-readable report is `footprint-win32.json`. On the Builder's Windows x64 Node 24.18.0 environment it recorded:

- cold start: `296.794 ms`
- idle working set: `73,203,712 bytes` (`≈69.8 MiB`), five samples over 400 ms
- RSS: unavailable through the portable Windows probe; the report records that limitation
- qualification: `NOT_QUALIFIED`
- architecture budget claim: `false`

These are host-specific measurements, not a reference-hardware qualification or a claim that the architecture budgets are met.

## Electron shell measurement

The Electron-specific opt-in measurement is recorded in
`footprint-electron-win32.json`:

```sh
corepack.cmd pnpm run measure:electron-footprint -- \
  --output docs/evidence/phase0/footprint-electron-win32.json
```

On the same Windows x64 host with Node `24.18.0`, Electron `44.9.0`, and a
local display, the runner recorded:

- cold start to the real Studio Floor renderer-ready result: `369.748 ms`
- idle window: five samples over `400 ms`
- aggregate Electron working set: `186,508,902 bytes` mean across the main
  Browser and renderer Tab processes (`101,012,275` + `85,496,627` bytes)
- aggregate Electron private bytes: `73,185,690 bytes` mean where exposed
  (`38,505,677` + `34,680,013` bytes)
- memory source: Electron `app.getAppMetrics()`; per-process and combined
  aggregates are retained in the JSON report
- qualification: `NOT_QUALIFIED`
- architecture budget claim: `false`

This is a host-specific measurement only. It does not qualify packaging,
visual/accessibility behavior, Linux secret-store behavior, or memory on other
platforms; those remain unrun.
