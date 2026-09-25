# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Optional `limit`/`offset` pagination for `GET /api/anchors` and
  `GET /api/corridors`. Both routes still return the full slug-ordered
  directory when no parameters are supplied, and invalid values return HTTP 400
  `invalid_pagination` (#57).
- A read-only anchor detail page at `/anchors/[slug]` that reuses the persisted
  anchor and reputation APIs, labels persisted synchronization state as
  "Synced" rather than live availability, and returns 404 for unknown slugs
  (#5, #59).
- Keyboard-navigation and visible-focus coverage for the anchor and corridor
  detail pages, including a focusable, arrow-key-scrollable rate-observations
  region (#59, #60).
- A consistent single-line JSON log format for the registry-bootstrap,
  rate-snapshot, and reputation scripts — timestamp, level, script name,
  message, and job-specific IDs — without changing what each script does
  (#58).

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
