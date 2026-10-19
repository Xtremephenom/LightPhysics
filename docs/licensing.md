# Licensing decision record

**Status:** Owner decision recorded: MIT. This document is informational and is not legal advice.

## Options

1. **MIT** — simple permissive distribution and contribution model; downstream users can make proprietary products. It requires copyright and license notices and gives limited express warranties.
2. **Apache-2.0** — permissive distribution with an explicit patent grant and more notice text. It is a stronger fit if contributors and downstream integrations need patent language.
3. **Dual or copyleft licensing** — can preserve reciprocal freedoms, but it may constrain proprietary game distributions and complicate links to GPL/AGPL tools. It should not be selected without counsel and a dependency-boundary review.

## Current Phase 0 position

The Owner selected MIT. The exact project license text is in the repository-root
`LICENSE` file and the decision is recorded in accepted ADR-0018. Unknown or
non-commercial third-party licenses are still treated as unavailable for
shipping until the exact license text, commercial-use terms, attribution
obligations, and compatibility are recorded. GPL tools may be used only as
separately reviewed processes; this bootstrap does not relicense them.

Before commercial release, review the complete dependency and model ledger with
counsel. The MIT decision must be reflected in release notices alongside all
third-party attribution and license requirements.
