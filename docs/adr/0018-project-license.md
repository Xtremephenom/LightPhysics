# ADR-0018 — Project license

Status: accepted
Date: 2026-10-19
Phase: 0

## Context

The Owner selected a project license before distribution. The repository must
carry the exact license text and keep third-party notices separate from the
project's own copyright and license decision.

## Options considered

- MIT, as listed in `docs/licensing.md`.
- Apache-2.0, with a broader patent and notice text.
- Dual or copyleft licensing, which would require additional compatibility and
  counsel review.

## Evidence

The Owner selected MIT. The canonical text is present in `LICENSE`, and the
decision is reflected in `docs/licensing.md`, `README.md`, and `THIRD_PARTY.md`.

## Decision

LightPhysics is released under the MIT License. The canonical text is in the
repository-root `LICENSE` file. This decision does not relicense third-party
dependencies or tools; their upstream terms and required notices remain in
`THIRD_PARTY.md` and the relevant research/evidence records.

## Consequences

Contributors and downstream users receive the permissive MIT rights subject to
the notice and warranty terms in `LICENSE`. A complete dependency, tool,
model, and attribution review is still required before a commercial release.

## How to revert

Supersede this ADR with a later accepted license ADR and replace `LICENSE`
after the Owner and counsel review the complete dependency and attribution
boundary.
