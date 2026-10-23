-- Add constraints without scanning or locking every existing row up front.
ALTER TABLE "rate_snapshots"
  ADD CONSTRAINT "rate_snapshots_rate_positive_chk" CHECK (rate > 0) NOT VALID,
  ADD CONSTRAINT "rate_snapshots_source_amount_positive_chk" CHECK (source_amount > 0) NOT VALID,
  ADD CONSTRAINT "rate_snapshots_destination_amount_positive_chk" CHECK (destination_amount > 0) NOT VALID,
  ADD CONSTRAINT "rate_snapshots_fee_nonnegative_chk" CHECK (fee >= 0) NOT VALID;

ALTER TABLE "reputation_scores"
  ADD CONSTRAINT "reputation_scores_composite_score_range_chk"
    CHECK (composite_score IS NULL OR (composite_score >= 0 AND composite_score <= 100)) NOT VALID,
  ADD CONSTRAINT "reputation_scores_fill_rate_7d_range_chk"
    CHECK (fill_rate_7d IS NULL OR (fill_rate_7d >= 0 AND fill_rate_7d <= 1)) NOT VALID,
  ADD CONSTRAINT "reputation_scores_fill_rate_30d_range_chk"
    CHECK (fill_rate_30d IS NULL OR (fill_rate_30d >= 0 AND fill_rate_30d <= 1)) NOT VALID,
  ADD CONSTRAINT "reputation_scores_fill_rate_90d_range_chk"
    CHECK (fill_rate_90d IS NULL OR (fill_rate_90d >= 0 AND fill_rate_90d <= 1)) NOT VALID,
  ADD CONSTRAINT "reputation_scores_settlement_metrics_nonnegative_chk"
    CHECK (COALESCE(settle_p50_ms, 0) >= 0 AND COALESCE(settle_p95_ms, 0) >= 0) NOT VALID,
  ADD CONSTRAINT "reputation_scores_settlement_percentiles_ordered_chk"
    CHECK (settle_p50_ms IS NULL OR settle_p95_ms IS NULL OR settle_p50_ms <= settle_p95_ms) NOT VALID,
  ADD CONSTRAINT "reputation_scores_slippage_percentiles_ordered_chk"
    CHECK (slippage_p50 IS NULL OR slippage_p95 IS NULL OR slippage_p50 <= slippage_p95) NOT VALID,
  ADD CONSTRAINT "reputation_scores_slippage_metrics_finite_chk"
    CHECK (
      (slippage_p50 IS NULL OR
        (slippage_p50 > '-Infinity'::float8 AND slippage_p50 < 'Infinity'::float8))
      AND
      (slippage_p95 IS NULL OR
        (slippage_p95 > '-Infinity'::float8 AND slippage_p95 < 'Infinity'::float8))
    ) NOT VALID,
  ADD CONSTRAINT "reputation_scores_sample_size_nonnegative_chk"
    CHECK (sample_size >= 0) NOT VALID,
  ADD CONSTRAINT "reputation_scores_state_coherence_chk"
    CHECK (
      (state = 'insufficient_data' AND composite_score IS NULL AND score_band IS NULL)
      OR
      (state = 'ok' AND composite_score IS NOT NULL AND score_band IS NOT NULL
        AND sample_size >= 30)
    ) NOT VALID,
  ADD CONSTRAINT "reputation_scores_score_band_threshold_chk"
    CHECK (
      composite_score IS NULL OR score_band IS NULL
      OR (score_band = 'red' AND composite_score < 80)
      OR (score_band = 'amber' AND composite_score >= 80 AND composite_score < 95)
      OR (score_band = 'green' AND composite_score >= 95)
    ) NOT VALID;

-- Fail closed before validation. Existing evidence is never repaired or
-- rewritten; only stable row IDs and violation categories enter the error.
DO $$
DECLARE
  violations jsonb;
BEGIN
  WITH audit AS (
    SELECT id, 'rate_snapshots.rate_not_positive' AS category
    FROM rate_snapshots WHERE rate <= 0
    UNION ALL SELECT id, 'rate_snapshots.source_amount_not_positive'
    FROM rate_snapshots WHERE source_amount <= 0
    UNION ALL SELECT id, 'rate_snapshots.destination_amount_not_positive'
    FROM rate_snapshots WHERE destination_amount <= 0
    UNION ALL SELECT id, 'rate_snapshots.fee_negative'
    FROM rate_snapshots WHERE fee < 0
    UNION ALL SELECT id, 'reputation_scores.composite_score_out_of_range'
    FROM reputation_scores WHERE composite_score IS NOT NULL
      AND NOT (composite_score >= 0 AND composite_score <= 100)
    UNION ALL SELECT id, 'reputation_scores.fill_rate_7d_out_of_range'
    FROM reputation_scores WHERE fill_rate_7d IS NOT NULL
      AND NOT (fill_rate_7d >= 0 AND fill_rate_7d <= 1)
    UNION ALL SELECT id, 'reputation_scores.fill_rate_30d_out_of_range'
    FROM reputation_scores WHERE fill_rate_30d IS NOT NULL
      AND NOT (fill_rate_30d >= 0 AND fill_rate_30d <= 1)
    UNION ALL SELECT id, 'reputation_scores.fill_rate_90d_out_of_range'
    FROM reputation_scores WHERE fill_rate_90d IS NOT NULL
      AND NOT (fill_rate_90d >= 0 AND fill_rate_90d <= 1)
    UNION ALL SELECT id, 'reputation_scores.settlement_metric_negative'
    FROM reputation_scores WHERE COALESCE(settle_p50_ms, 0) < 0
      OR COALESCE(settle_p95_ms, 0) < 0
    UNION ALL SELECT id, 'reputation_scores.settlement_percentiles_inverted'
    FROM reputation_scores WHERE settle_p50_ms IS NOT NULL
      AND settle_p95_ms IS NOT NULL AND settle_p50_ms > settle_p95_ms
    UNION ALL SELECT id, 'reputation_scores.slippage_percentiles_inverted'
    FROM reputation_scores WHERE slippage_p50 IS NOT NULL
      AND slippage_p95 IS NOT NULL AND slippage_p50 > slippage_p95
    UNION ALL SELECT id, 'reputation_scores.slippage_metric_nonfinite'
    FROM reputation_scores
    WHERE (slippage_p50 IS NOT NULL
        AND NOT (slippage_p50 > '-Infinity'::float8 AND slippage_p50 < 'Infinity'::float8))
      OR (slippage_p95 IS NOT NULL
        AND NOT (slippage_p95 > '-Infinity'::float8 AND slippage_p95 < 'Infinity'::float8))
    UNION ALL SELECT id, 'reputation_scores.sample_size_negative'
    FROM reputation_scores WHERE sample_size < 0
    UNION ALL SELECT id, 'reputation_scores.state_score_band_incoherent'
    FROM reputation_scores WHERE NOT (
      (state = 'insufficient_data' AND composite_score IS NULL AND score_band IS NULL)
      OR (state = 'ok' AND composite_score IS NOT NULL AND score_band IS NOT NULL
        AND sample_size >= 30)
    )
    UNION ALL SELECT id, 'reputation_scores.score_band_threshold_incoherent'
    FROM reputation_scores WHERE composite_score IS NOT NULL AND score_band IS NOT NULL
      AND NOT (
        (score_band = 'red' AND composite_score < 80)
        OR (score_band = 'amber' AND composite_score >= 80 AND composite_score < 95)
        OR (score_band = 'green' AND composite_score >= 95)
      )
  )
  SELECT jsonb_agg(jsonb_build_object('id', id, 'category', category)
    ORDER BY category, id) INTO violations FROM audit;

  IF violations IS NOT NULL THEN
    RAISE EXCEPTION 'Evidence invariant audit failed: %', violations
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

ALTER TABLE "rate_snapshots"
  VALIDATE CONSTRAINT "rate_snapshots_rate_positive_chk",
  VALIDATE CONSTRAINT "rate_snapshots_source_amount_positive_chk",
  VALIDATE CONSTRAINT "rate_snapshots_destination_amount_positive_chk",
  VALIDATE CONSTRAINT "rate_snapshots_fee_nonnegative_chk";

ALTER TABLE "reputation_scores"
  VALIDATE CONSTRAINT "reputation_scores_composite_score_range_chk",
  VALIDATE CONSTRAINT "reputation_scores_fill_rate_7d_range_chk",
  VALIDATE CONSTRAINT "reputation_scores_fill_rate_30d_range_chk",
  VALIDATE CONSTRAINT "reputation_scores_fill_rate_90d_range_chk",
  VALIDATE CONSTRAINT "reputation_scores_settlement_metrics_nonnegative_chk",
  VALIDATE CONSTRAINT "reputation_scores_settlement_percentiles_ordered_chk",
  VALIDATE CONSTRAINT "reputation_scores_slippage_percentiles_ordered_chk",
  VALIDATE CONSTRAINT "reputation_scores_slippage_metrics_finite_chk",
  VALIDATE CONSTRAINT "reputation_scores_sample_size_nonnegative_chk",
  VALIDATE CONSTRAINT "reputation_scores_state_coherence_chk",
  VALIDATE CONSTRAINT "reputation_scores_score_band_threshold_chk";
