# RFC: locking and recovery for scheduled refresh

## Context

StellarCore currently runs one Vercel Cron invocation at midnight UTC. The
refresh route ingests the reviewed live-rate sources and then evaluates
persisted anchor reputation. A single function is adequate for the current
three-anchor scope, but it is not a safe scaling boundary: a timeout can leave
some anchors unprocessed, and a second invocation could overlap the first.

This proposal covers the coordination work needed before the reviewed source
set grows materially. It does not implement a lock or change the existing cron.

## Recommendation: PostgreSQL advisory lock with bounded ownership

Use a transaction-scoped PostgreSQL advisory lock keyed to a stable StellarCore
refresh identifier. The refresh entrypoint would attempt `pg_try_advisory_lock`
before doing work and return a non-error `already_running` result when another
invocation owns the cycle. The lock connection must remain checked out for the
whole refresh and be released in `finally`; a lost database connection releases
the session lock automatically.

The implementation should also write a run record containing run id, started,
completed, outcome, and per-anchor results. The advisory lock prevents overlap,
while the run record provides diagnostics and a basis for resumption.

## Alternatives and trade-offs

### Dedicated `sync_lock` table with heartbeat

A table row containing an owner id, lease expiry, and heartbeat supports an
explicit lease and can show operator-facing ownership details. It also allows a
new worker to reclaim a stale lease after a timeout. The cost is more schema,
heartbeat updates, clock/lease edge cases, and cleanup logic. A lease can be
safer for work that must survive a connection drop, but it is more code than
the current low-volume scheduler needs.

### Third-party distributed lock service

Redis or a hosted lock service can coordinate workers independently of the
application database and is useful once refresh work is moved to a queue or
workers. It introduces another credential, availability dependency, timeout
policy, and operational system. It is not justified while Vercel Cron invokes a
single short-lived function and PostgreSQL is already the source of record.

## Partial failure and resumption

Each anchor should be processed independently. A failure should be recorded
with the anchor slug, phase, error code, and attempt number; successful anchors
must remain committed. The run should continue to the remaining anchors and
return a summary with attempted, succeeded, failed, and skipped counts.

On the next scheduled run, the system should retry failed or stale work. If
refresh duration eventually exceeds a single function budget, split the work
into bounded batches and persist a cursor or queue items. Do not claim a median
from incomplete fresh evidence: existing rate-state rules must continue to
publish `insufficient_fresh_sources` when the evidence threshold is not met.

## Interaction with production workflows

- `deploy-production-migrations.yml` remains a manually approved migration
  workflow. Any run-history or lock-table migration must be committed and
  applied there before the application begins using it.
- `bootstrap-production-registry.yml` remains a separate, manually invoked
  registry synchronization. It should not acquire the refresh lock because it
  mutates a different lifecycle and is already protected by its own workflow
  concurrency group.
- `vercel.json` and `/api/internal/cron/refresh` should remain unchanged for
  this RFC. The lock belongs inside the future refresh orchestration boundary,
  after authentication and before source work begins.

## Rough implementation scope

1. Add a migration and typed repository for refresh-run records.
2. Add lock acquisition/release around the refresh orchestration using one
   database connection, with structured `already_running` output.
3. Split source work into independently persisted operations and add retry/
   resume rules.
4. Add unit and integration tests for overlap, connection loss, partial
   failure, retry, and successful completion.
5. Add operator documentation and metrics for run duration, lock contention,
   stale work, and per-anchor failures.

The first advisory-lock version is a small-to-medium application change; the
batch/resumption design becomes a larger migration once the work no longer fits
comfortably inside one Vercel function.
