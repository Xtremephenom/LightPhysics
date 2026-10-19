# Phase 0 technical close audit

## Recorded boundary

- Audit source revision: `810a446`.
- Technical Phase 0 criteria are closed only for the profiles and behaviors
  recorded in `docs/evidence/phase0/INDEX.md`.
- No broader engine, additional-tool, native non-x64, packaging, rendering,
  gameplay, or unrelated infrastructure qualification is claimed.
- The Owner-selected MIT project license is recorded in `LICENSE` and ADR-0018;
  it is not inferred from FFmpeg, Blender, or any other upstream license.

## Checks

```text
corepack.cmd pnpm run test: PASS — 51 root tests, 33 workspace Vitest tests
node scripts/state-lint.mjs: PASS — 110 lines and required sections present
node scripts/ledger-lint.mjs: PASS — 13 entries checked
node scripts/pin-check.mjs: PASS — runtime/package-manager/lockfile/Docker pins agree
docker run --rm --network none lightphysics:test make test: PASS — 51 root tests, 33 workspace Vitest tests
LP_SMOKE_TOKEN=<redacted> bash scripts/verify-rebuild.sh 0: PASS from committed checkout bbacc39
```

The committed rebuild proof includes the hash-checked FFmpeg Linux artifact
install, the base-stage deterministic FFmpeg version/lavfi smoke, the
network-disabled test image, the real Studio Floor Playwright journey, and the
authenticated runtime smoke. The final receipt is
`docs/evidence/phase0/verify-rebuild.md`.

## License boundary

P0-E11 is demonstrated by `LICENSE` and accepted ADR-0018. Third-party
licenses, attribution, and commercial-clearance review remain separate; the
technical boundary and all remaining unverified profiles are explicitly listed
instead of being generalized.
