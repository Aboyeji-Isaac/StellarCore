# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Read-only bounded integrity auditing for persisted evidence relationships and semantic invariants (#190).
- Versioned public API compatibility fixtures and CI breaking-change gates for anchors, corridors, rates, and reputation (#208).
- Typed startup runtime configuration validation with environment-specific requirements and secret-safe diagnostics (#175).
- GitHub issue template for proposing a new corridor to the StellarCore registry (#4).
- Exact asset identity enforcement and exact decimal arithmetic validation for normalized SEP-38 rate observations (#164).
- Hardened PostgreSQL pool management with bounded connection acquisition, TCP keepalive, connection lifetime recycling, and failover-aware stale-connection handling (#209).
- Database deadline and transaction-safety helpers for failover windows, including explicit ambiguous-commit reporting (#209).
- Isolated PostgreSQL wire-level failover tests covering outage, recovery, interrupted transactions, deadlines, and pool storm bounds (#209).
- Operational failover behavior and tuning guidance in `docs/database-failover.md` (#209).

### Fixed

- Prevented stale pooled PostgreSQL connections from being reused indefinitely after transient primary termination or endpoint rotation (#209).

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
