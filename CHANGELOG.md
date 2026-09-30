# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- A required **Database integration** CI job (`.github/workflows/database-integration.yml`)
  that provisions a pinned, ephemeral PostgreSQL 17 service, applies the
  complete committed migration chain from zero, generates the Prisma Client,
  and runs every database-gated integration suite with all gate variables
  enabled — skipped suites fail the job. It also verifies migration safety:
  pending migrations must reproduce the full-chain history from an already
  migrated baseline, with no destructive reset. `npm run test:db` and
  `npm run verify:migrations` reproduce the same sequence locally; failure
  diagnostics are sanitized and contain no credentials.
- Immutable, versioned evidence-set manifests persisted atomically with every
  new reputation evaluation. Each manifest names the exact persisted rate
  snapshots, transfer outcomes, corridor memberships, and anchor state read for
  that evaluation, classifies each candidate deterministically as eligible,
  excluded, or outside the relevant window, and records the evaluation time,
  scoring/freshness policy versions, and reviewed configuration revision.
  Legacy evaluations without a manifest remain readable with explicit
  legacy/unknown lineage rather than reconstructed membership.
- `npm run reputation:manifest` to print one bounded, sanitized evidence-set
  manifest for an evaluation id or an anchor's latest evaluation.
- Distributed locking and a resumable refresh-run ledger for the scheduled
  refresh. A session-scoped PostgreSQL advisory lock returns a non-error
  `already_running` result on contention, every attempt persists durable run
  and phase state, an interrupted run is reclaimed as failed, and a terminal
  run can be safely resumed without re-executing completed phases. See
  [docs/runbook-scheduled-refresh.md](docs/runbook-scheduled-refresh.md).
- `npm run refresh:runs` to inspect recent refresh runs and resume a failed or
  partially succeeded run.

### Changed

- The internal cron response now carries the durable run id and truthful
  terminal state: `succeeded`, `partially_succeeded`, `failed`, or
  `already_running`.

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
