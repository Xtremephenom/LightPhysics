# Offline Forge catalog

The Phase 2 catalog is **strict JSON**, one bounded JSON document per record. JSON
is intentionally used instead of YAML so a clean/offline checkout needs no YAML
parser and produces deterministic parse results. The directory layout is:

```text
catalog/
  providers/*.json
  models/*.json
  workflows/*.json
  pricing/*.json
```

Every document has a `kind`, `schema_version: 1`, an `id` matching its filename,
`capabilities`, `hardware`, `fidelity_map`, `qualification`, `verified_at`, and
`ledger_id`. Provider/model/workflow/pricing records also carry a license object
with `id`, `commercial_use`, `source`, `verified_at`, and `ledger_id`. Capability
IDs are the stable taxonomy from `docs/pack/04_FORGE_AND_MODEL_ATLAS.md §2`.

Run the standalone validator from the repository root:

```text
node scripts/catalog-lint.mjs
node scripts/catalog-lint.mjs --catalog path/to/catalog
```

The validator bounds file size, aggregate input, nesting, strings, keys, and
record count. An unknown license is conservatively non-commercial: it is valid
only when `commercial_use` is `false` (or omitted), and is reported as a
warning. A `QUALIFIED` model must be explicitly marked `fixture: true`; this
prevents a real model from receiving an invented qualification result. The
checked-in records are deliberately small mock/fixture entries and do not claim
real-model quality, latency, VRAM, or hosted-provider qualification.
