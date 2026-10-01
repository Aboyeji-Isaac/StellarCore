# Database Maintenance & Bloat Safeguards

This document defines the maintenance policies and autovacuum tuning guidance for StellarCore's append-heavy evidence tables, specifically `rate_snapshots` and `transfer_outcomes`.

## Write/Update Patterns
The core evidence pipeline is append-heavy.
- **`rate_snapshots`**: Actively appended to as new measurements are recorded. Updates and deletes are rare (primarily handled by separate archival jobs).
- **`transfer_outcomes`**: Actively appended tracking individual transfer resolutions.

Because these tables are heavily indexed to serve critical paths (e.g., `rate_snapshots_latest_observation_idx`), the indexes are susceptible to bloat over time as dead tuples from archival deletions or aborted transactions accumulate.

## Autovacuum & Analyze Tuning Guidance
By default, PostgreSQL triggers autovacuum based on a scale factor of 20% table modifications. For tables growing into the hundreds of millions of rows, 20% translates to millions of dead tuples, leading to massive index bloat before maintenance kicks in.

We recommend measuring your deployment's specific write rates to determine if default table-level autovacuum parameters need adjustment. If defaults allow excessive bloat, here is an example of conservative tuning starting points (ensure you validate against your cloud provider's allowed configurations):
```sql
ALTER TABLE rate_snapshots SET (
  autovacuum_vacuum_scale_factor = 0.05, -- Example starting point: trigger vacuum sooner than the 20% default
  autovacuum_analyze_scale_factor = 0.05
);
```

## Maintenance Thresholds & Escalation
These are *deployment-specific starting points* and should be tuned to your observed workloads:
- **Dead Tuples**: Evaluate autovacuum health if dead tuples consistently exceed a measured tolerance (e.g., if observed exceeding 5-10% of total rows without cleanup).
- **Index Bloat**: If an index exceeds the size of its table's heap significantly (e.g., observed at 2x) or shows significant fragmentation, consider scheduling maintenance.
- **Stale Statistics**: Monitor `last_autovacuum` or `last_autoanalyze`. If statistics age beyond your measured tolerance for stable query plans, intervention may be required.

## Safe Maintenance Practices
**NEVER RUN `VACUUM FULL` UNATTENDED.**
`VACUUM FULL` takes an exclusive lock on the table, which will instantly block all evidence ingestion pipelines and API reads, leading to immediate system degradation.

To reclaim index bloat safely without blocking reads/writes:
1. Use `REINDEX CONCURRENTLY` for indexes.
2. Use standard `VACUUM` (non-full) to mark dead tuples for reuse.
3. For severe table bloat, use `pg_repack` or `pg_squeeze` if supported by your cloud provider.

## Post-Maintenance Verification
After any manual maintenance, always run the plan budget test suite to ensure the query planner still favors correct index scans over full-table sequential scans.
