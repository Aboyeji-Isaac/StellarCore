# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Security

- Enforce least-privilege PostgreSQL roles (#124): separate read-only
  (`DATABASE_READ_URL`), internal writer (`DATABASE_WRITE_URL`), and migration
  owner (`MIGRATION_DATABASE_URL`) credentials with no fallback between them;
  add the reviewed, idempotent `npm run db:grants` plan with default
  privileges for future migrations; route public repositories through a
  read-only client and mutation paths through the writer; enforce the import
  boundary with ESLint and an import-graph test; and prove allowed and denied
  operations against real PostgreSQL. **Breaking configuration:** the runtime
  no longer reads `DATABASE_URL`; see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md#migrating-an-existing-single-credential-deployment).

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
