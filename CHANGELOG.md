# Changelog

All notable changes to StellarCore are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Entries start under `Unreleased` and move into a dated release when that release
ships. See [CONTRIBUTING.md](CONTRIBUTING.md#changelog) for how to add an entry
with your pull request.

## [Unreleased]

### Added

- Versioned rate-capture scheduling contract that derives the largest supported
  capture interval from `RATE_FRESHNESS_THRESHOLD_MS` and a documented
  execution-time safety margin, with an offline repository audit
  (`npm run audit:scheduling`) that rejects a cadence the freshness rule cannot
  support.
- Independent, authenticated rate-capture boundary
  (`GET /api/internal/cron/capture-rates`) with bounded execution, PostgreSQL
  advisory-lock overlap protection, durable capture-run lineage, and a
  configuration fingerprint per run.
- Sanitized, authenticated cadence-health operator signal
  (`GET /api/internal/capture-health`) that reports capture-process health and
  explicitly disclaims anchor reachability, quote availability, transfer
  success, and rate evidence.
- Approved scheduler manifests under `deploy/scheduler/` and the
  `RATE_CAPTURE_SCHEDULER` server-only provider selection, disabled by default.
- `rate_capture_runs` table and `rate_snapshots.capture_run_id` lineage.

### Changed

- `/api/internal/cron/refresh` now evaluates reputation only and no longer
  captures rates; the daily Vercel Cron schedule is unchanged.
- `rate_snapshots` lineage is written by the capture boundary, so every
  scheduled observation is traceable to the run and reviewed configuration that
  produced it.

### Notes

- Freshness semantics, `RATE_FRESHNESS_THRESHOLD_MS`, and `MIN_FRESH_SOURCES`
  are unchanged. With the single reviewed Zeam source the public median remains
  null with `insufficient_fresh_sources` even when captures are fresh.

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
