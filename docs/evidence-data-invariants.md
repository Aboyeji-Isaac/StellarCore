# Evidence-data invariants

PostgreSQL check constraints protect the evidence semantics already produced by
rate normalization and reputation calculation. They do not introduce transfer
outcome semantics, change scoring, or repair historical rows.

## Pre-deployment audit

Run the read-only audit against the target database before deploying the
migration:

```sh
psql "$DATABASE_URL" --set ON_ERROR_STOP=1 \
  --file prisma/audits/evidence_data_invariants.sql
```

An empty result is required. Each result contains only the exact row `id` and a
stable constraint category; raw evidence values and payloads are omitted. Stop
the deployment if any rows are returned and create a separately reviewed repair
plan. Never clamp, coerce, delete, or manufacture evidence to pass the audit.

## Staged migration

The migration adds named constraints as `NOT VALID`, repeats the audit inside
the migration, and raises a `check_violation` if existing evidence conflicts.
Only a clean table proceeds to explicit `VALIDATE CONSTRAINT` statements. New
writes are constrained immediately after `ADD CONSTRAINT`, including during the
validation scan.

Rate snapshots require positive rate, source amount, and destination amount,
plus a non-negative fee. Reputation scores require a 0–100 composite score,
0–1 fill-rate metrics, non-negative and ordered settlement percentiles,
non-negative sample size, ordered slippage percentiles, and coherent state,
score, band, threshold, and minimum-sample combinations.

Slippage values must be finite but deliberately have no sign constraint: current calculation code
accepts finite negative values and does not establish that favorable slippage is
invalid. Nullable metrics remain nullable in both reputation states.

`TransferOutcome` is intentionally unchanged pending the ingestion and evidence
decisions tracked in #18 and #20.

## Application errors

PostgreSQL reports a failed check with SQLSTATE `23514`; Prisma normally wraps
database constraint failures in a bounded client error. Rate snapshot writes
already return `PERSISTENCE_FAILURE`, and reputation evaluation returns the same
bounded code. Neither path serializes the Prisma message, constraint name, SQL,
or supplied evidence.

## Rollback

Rollback removes enforcement only; it cannot and must not alter evidence:

```sql
ALTER TABLE rate_snapshots
  DROP CONSTRAINT IF EXISTS rate_snapshots_rate_positive_chk,
  DROP CONSTRAINT IF EXISTS rate_snapshots_source_amount_positive_chk,
  DROP CONSTRAINT IF EXISTS rate_snapshots_destination_amount_positive_chk,
  DROP CONSTRAINT IF EXISTS rate_snapshots_fee_nonnegative_chk;

ALTER TABLE reputation_scores
  DROP CONSTRAINT IF EXISTS reputation_scores_composite_score_range_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_fill_rate_7d_range_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_fill_rate_30d_range_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_fill_rate_90d_range_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_settlement_metrics_nonnegative_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_settlement_percentiles_ordered_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_slippage_percentiles_ordered_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_slippage_metrics_finite_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_sample_size_nonnegative_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_state_coherence_chk,
  DROP CONSTRAINT IF EXISTS reputation_scores_score_band_threshold_chk;
```
