# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Hardened PostgreSQL connection pool management with bounded timeouts, TCP keepalive, connection lifetime recycling, and idle error handling.
- Explicit classification of connection and failover errors to trigger pool eviction and fast failure without misclassifying normal query errors.
- Bounded deadline utilities (`withDatabaseDeadline`) ensuring database operations respect request deadlines during network disruptions.
- Transaction safety guards (`executeSafeTransaction`) guaranteeing that transactions interrupted by failover or ambiguous commits never report success without confirmation.
- Isolated integration tests covering primary termination, endpoint switch, recovery, and storm prevention.
- Operational documentation in `docs/database-failover.md` describing degraded behavior during failovers and recovery dynamics.

### Fixed

- Prevented broken pooled PostgreSQL connections from hanging indefinitely or being reused after primary termination.

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
