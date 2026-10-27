import type { EvidenceIntegrityViolationCode } from "@/types/integrity";

/**
 * Non-destructive remediation guidance per violation class. The audit never
 * deletes or rewrites evidence; operators decide how to reconcile each class
 * after reviewing the persisted record identifiers in the report.
 */
export const EVIDENCE_INTEGRITY_REMEDIATION: Readonly<
  Record<EvidenceIntegrityViolationCode, string>
> = Object.freeze({
  RATE_SNAPSHOT_MEMBERSHIP_MISSING:
    "The rate snapshot references an anchor/corridor pair that is not a persisted reviewed membership. Reconcile the reviewed anchor-corridor registry and re-run bootstrap, then decide whether the orphaned snapshot should be retained as historical evidence.",
  TRANSFER_OUTCOME_MEMBERSHIP_MISSING:
    "The transfer outcome references an anchor/corridor pair that is not a persisted reviewed membership. Confirm the reviewed mapping, re-run bootstrap, and review the outcome source before keeping the row.",
  DUPLICATE_CORRIDOR_SEMANTIC_IDENTITY:
    "Two persisted corridors describe the same asset/country tuple. Choose the canonical slug, migrate associations and evidence through an explicit reviewed migration, and remove the duplicate only after evidence is re-pointed.",
  RATE_SNAPSHOT_TIMESTAMP_FUTURE:
    "The snapshot capture time is ahead of the audit clock beyond tolerance. Verify the writer clock and the SEP-38 response, then correct or re-capture the observation; do not silently relabel it as fresh.",
  RATE_SNAPSHOT_TIMESTAMP_BEFORE_ANCHOR:
    "The snapshot predates the anchor record. This usually means imported history or a restore mismatch; confirm provenance before trusting the snapshot in freshness or median reads.",
  TRANSFER_OUTCOME_TIMESTAMP_FUTURE:
    "The outcome record time is ahead of the audit clock beyond tolerance. Verify the ingestion clock and source, then correct the record; do not treat it as current evidence.",
  TRANSFER_OUTCOME_TIMESTAMP_BEFORE_ANCHOR:
    "The outcome predates the anchor record. Confirm the import/restore provenance and re-ingest through the reviewed boundary if the row is unreliable.",
  REPUTATION_SCORE_TIMESTAMP_FUTURE:
    "The persisted score was computed at a time ahead of the audit clock. Verify the scheduled-refresh clock and re-run reputation evaluation from persisted evidence.",
  REPUTATION_SCORE_TIMESTAMP_BEFORE_ANCHOR:
    "The persisted score predates its anchor record. Treat it as stale, then re-run reputation evaluation so the current row is recomputed from persisted evidence.",
  REPUTATION_STATE_OK_WITH_INSUFFICIENT_SAMPLE:
    "A published score must have at least the documented minimum outcomes in the trailing window. Re-run reputation evaluation so the row reflects the actual sample, or investigate how the state was written.",
  REPUTATION_STATE_OK_WITHOUT_COMPOSITE_SCORE:
    "State OK requires a composite score. Re-run reputation evaluation to rebuild the row from persisted evidence and investigate the write path that produced an inconsistent state.",
  REPUTATION_STATE_OK_WITHOUT_SCORE_BAND:
    "State OK requires a score band. Re-run reputation evaluation to recompute the band from the composite score.",
  REPUTATION_INSUFFICIENT_DATA_WITH_SCORE:
    "Insufficient-data rows must not publish a score or band. Re-run reputation evaluation so the row is recomputed consistently.",
  REPUTATION_COMPOSITE_SCORE_OUT_OF_RANGE:
    "Composite scores are documented as 0-100. Re-run reputation evaluation to recompute the deterministic score from persisted evidence.",
  REPUTATION_SCORE_BAND_MISMATCH:
    "The persisted band disagrees with the documented thresholds for its score. Re-run reputation evaluation so score and band are recomputed together.",
  REPUTATION_SAMPLE_SIZE_NEGATIVE:
    "A sample size cannot be negative. Re-run reputation evaluation and investigate how the row was written.",
  REPUTATION_FILL_RATE_OUT_OF_RANGE:
    "Fill rates are ratios in [0, 1]. Re-run reputation evaluation to recompute the explanatory metric from persisted outcomes.",
  REPUTATION_PERCENTILE_ORDER:
    "A p50 must not exceed its p95 for the same metric. Re-run reputation evaluation to recompute deterministic nearest-rank percentiles.",
  REPUTATION_DURATION_NEGATIVE:
    "Settlement durations cannot be negative. Re-run reputation evaluation and review the outcome source that produced the value.",
  RATE_SNAPSHOT_NON_POSITIVE_AMOUNT:
    "Rate, source amount, and destination amount must be strictly positive. Reject or re-capture the observation through the reviewed SEP-38 normalization boundary.",
  RATE_SNAPSHOT_NEGATIVE_FEE:
    "Snapshot fees must not be negative. Re-capture the observation through the reviewed SEP-38 normalization boundary.",
  TRANSFER_OUTCOME_INVALID_METRIC:
    "Outcome metrics must be finite numbers. Reject or re-ingest the outcome through the reviewed boundary; do not let NaN/Infinity flow into scoring.",
  TRANSFER_OUTCOME_NEGATIVE_SETTLEMENT:
    "Settlement durations cannot be negative. Review the outcome source and re-ingest through the reviewed boundary.",
  TRANSFER_OUTCOME_FILL_RATE_OUT_OF_RANGE:
    "Outcome fill rates are ratios in [0, 1]. Reject or re-ingest the outcome through the reviewed boundary.",
});
