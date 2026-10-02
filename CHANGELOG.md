# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Added an append-only operator audit ledger for privileged
  evidence-management actions, with typed action/reason vocabularies, truthful
  system/human actor identity, and bounded, sanitized rationale.
- Added reviewed administrative operations with an explicit dry-run/apply
  distinction: rate snapshot invalidation, supersession, and recovery, plus
  anchor retirement and reactivation. Each applied change commits atomically
  with exactly one immutable ledger row.
- Added read-only operator audit inspection (`npm run audit:operators`) and a
  dry-run-first operator action CLI (`npm run operator:action`).
- Added isolated PostgreSQL tests proving audit atomicity, database-enforced
  immutability, rollback on failure, and read-model integration.

### Changed

- Retired anchors are excluded from the public anchor/corridor and latest-rate
  read models, and rate-snapshot persistence is rejected for them. Historical
  evidence rows are never rewritten to encode administrative state.

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
