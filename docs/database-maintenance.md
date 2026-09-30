# Database Maintenance & Bloat Safeguards

This document defines the maintenance policies and autovacuum tuning guidance for StellarCore's append-heavy evidence tables, specifically \`rate_snapshots\` and \`transfer_outcomes\`.

## Write/Update Patterns
The core evidence pipeline is extremely append-heavy.
- **\`rate_snapshots\`**: Receives thousands of inserts per minute. Updates and deletes are extremely rare (primarily handled by separate archival jobs).
- **\`transfer_outcomes\`**: High volume inserts, tracking individual transfer resolutions.

Because these tables are heavily indexed to serve critical paths (e.g., \`rate_snapshots_latest_observation_idx\`), the indexes are susceptible to bloat over time as dead tuples from archival deletions or aborted transactions accumulate.

## Autovacuum & Analyze Tuning Guidance
By default, PostgreSQL triggers autovacuum based on a scale factor of 20% table modifications. For tables growing into the hundreds of millions of rows, 20% translates to millions of dead tuples, leading to massive index bloat before maintenance kicks in.

We recommend altering the table-level autovacuum parameters for append-heavy tables:
\`\`\`sql
ALTER TABLE rate_snapshots SET (
  autovacuum_vacuum_scale_factor = 0.02, -- Trigger vacuum at 2% dead tuples
  autovacuum_analyze_scale_factor = 0.01, -- Analyze frequently to keep planner stats fresh
  autovacuum_vacuum_cost_limit = 2000, -- Allow autovacuum to work harder without throttling
  autovacuum_vacuum_cost_delay = 2 -- Decrease throttling delay
);
\`\`\`

## Maintenance Thresholds & Escalation
- **Dead Tuples**: If dead tuples exceed 5% of total rows on a major evidence table, autovacuum is likely falling behind.
- **Index Bloat**: If an index exceeds 2x the size of its table's heap or shows significant fragmentation (pages mostly empty), it needs maintenance.
- **Stale Statistics**: If \`last_autovacuum\` or \`last_autoanalyze\` is more than 24 hours old on actively appended tables, intervention is required.

## Safe Maintenance Practices
**NEVER RUN \`VACUUM FULL\` UNATTENDED.**
\`VACUUM FULL\` takes an exclusive lock on the table, which will instantly block all evidence ingestion pipelines and API reads, leading to immediate system degradation.

To reclaim index bloat safely without blocking reads/writes:
1. Use \`REINDEX CONCURRENTLY\` for indexes.
2. Use standard \`VACUUM\` (non-full) to mark dead tuples for reuse.
3. For severe table bloat, use \`pg_repack\` or \`pg_squeeze\` if supported by your cloud provider.

## Post-Maintenance Verification
After any manual maintenance, always run the plan budget test suite (\`tests/integration/planBudgets.integration.test.ts\`) to ensure the query planner still favors correct index scans over full-table sequential scans.
