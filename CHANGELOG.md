# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Reviewed source-authority identity for reviewed rate sources (#122). Each
  reviewed source now carries a stable, opaque, versioned `authorityId` from
  `constants/sourceAuthorities.ts`; the offline configuration audit rejects a
  missing, malformed, duplicate, unreviewed, or contradictory authority
  mapping.
- Persisted authority provenance on `rate_snapshots`
  (`authority_id`, `authority_configuration_version`) with a database CHECK
  that keeps the pair all-or-nothing.
- Authority-aware latest-rate selection: at most one deterministic observation
  per reviewed authority per corridor, chosen by freshness, then capture order,
  then stable snapshot id. Correlated observations stay visible as evidence with
  the `correlated_same_authority` exclusion, and observations with no persisted
  authority are excluded as `unknown_authority` rather than guessed.
- Public rate evidence now reports `totalObservationCount`,
  `freshObservationCount`, `independentAuthorityCount`, and per-observation
  `authority` metadata, while `reviewedCandidateConfiguration` gains
  `uniqueAuthorityCount`.

### Changed

- `MIN_FRESH_SOURCES=2` now counts independent reviewed authorities rather than
  distinct anchor slugs. The single current Zeam authority still yields
  `insufficient_fresh_sources` and a null median.

### Migration

- `rate_snapshots.authority_id` and `authority_configuration_version` are added
  as nullable columns. Legacy rows are migrated as authority-unknown and are
  never counted as independent from a reviewed authority; no historical mapping
  is fabricated.

### Removed

- `LatestCorridorRate.totalIndependentSources` and `freshSourceCount` were
  replaced by explicit `totalObservationCount`, `freshObservationCount`,
  `independentAuthorityCount`, and `freshIndependentSourceCount` fields on the
  internal read model.

## [Prior work] — 2026-09-25

Summary of development before this changelog was introduced. Only highlights
are listed; see the full commit history for details.

### Added

- SEP-10 authentication boundary and opt-in integration harness.
- SEP-38 quote client and rate engine with live rate sources, a latest-rate
  read model, and a public rates API.
- Public anchors and corridors APIs with reviewed, offline-auditable
  anchor/corridor registries.
- Reputation engine and public reputation API.
- Scheduled refresh for keeping rates and evidence current.
- Public dashboard and landing page, including rate-source, anchor-capability,
  and evidence-legend transparency.
- Production deployment on Vercel with a manual production-migration workflow
  and a manual production registry bootstrap workflow.

### Changed

- Aligned rate identity with persisted evidence.
- Aligned documentation with production and added the contribution workflow.

[Unreleased]: https://github.com/Aboyeji-Isaac/StellarCore/commits/main/
[Prior work]: https://github.com/Aboyeji-Isaac/StellarCore/tree/main
