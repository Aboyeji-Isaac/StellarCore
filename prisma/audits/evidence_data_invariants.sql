-- Read-only pre-migration audit for evidence-data check constraints.
-- Returns exact row IDs and stable categories; no evidence values are emitted.
WITH violations AS (
  SELECT id, 'rate_snapshots.rate_not_positive' AS category
  FROM rate_snapshots WHERE rate <= 0
  UNION ALL
  SELECT id, 'rate_snapshots.source_amount_not_positive'
  FROM rate_snapshots WHERE source_amount <= 0
  UNION ALL
  SELECT id, 'rate_snapshots.destination_amount_not_positive'
  FROM rate_snapshots WHERE destination_amount <= 0
  UNION ALL
  SELECT id, 'rate_snapshots.fee_negative'
  FROM rate_snapshots WHERE fee < 0
  UNION ALL
  SELECT id, 'reputation_scores.composite_score_out_of_range'
  FROM reputation_scores
  WHERE composite_score IS NOT NULL
    AND NOT (composite_score >= 0 AND composite_score <= 100)
  UNION ALL
  SELECT id, 'reputation_scores.fill_rate_7d_out_of_range'
  FROM reputation_scores
  WHERE fill_rate_7d IS NOT NULL
    AND NOT (fill_rate_7d >= 0 AND fill_rate_7d <= 1)
  UNION ALL
  SELECT id, 'reputation_scores.fill_rate_30d_out_of_range'
  FROM reputation_scores
  WHERE fill_rate_30d IS NOT NULL
    AND NOT (fill_rate_30d >= 0 AND fill_rate_30d <= 1)
  UNION ALL
  SELECT id, 'reputation_scores.fill_rate_90d_out_of_range'
  FROM reputation_scores
  WHERE fill_rate_90d IS NOT NULL
    AND NOT (fill_rate_90d >= 0 AND fill_rate_90d <= 1)
  UNION ALL
  SELECT id, 'reputation_scores.settlement_metric_negative'
  FROM reputation_scores
  WHERE COALESCE(settle_p50_ms, 0) < 0 OR COALESCE(settle_p95_ms, 0) < 0
  UNION ALL
  SELECT id, 'reputation_scores.settlement_percentiles_inverted'
  FROM reputation_scores
  WHERE settle_p50_ms IS NOT NULL AND settle_p95_ms IS NOT NULL
    AND settle_p50_ms > settle_p95_ms
  UNION ALL
  SELECT id, 'reputation_scores.slippage_percentiles_inverted'
  FROM reputation_scores
  WHERE slippage_p50 IS NOT NULL AND slippage_p95 IS NOT NULL
    AND slippage_p50 > slippage_p95
  UNION ALL
  SELECT id, 'reputation_scores.slippage_metric_nonfinite'
  FROM reputation_scores
  WHERE (slippage_p50 IS NOT NULL
      AND NOT (slippage_p50 > '-Infinity'::float8 AND slippage_p50 < 'Infinity'::float8))
    OR (slippage_p95 IS NOT NULL
      AND NOT (slippage_p95 > '-Infinity'::float8 AND slippage_p95 < 'Infinity'::float8))
  UNION ALL
  SELECT id, 'reputation_scores.sample_size_negative'
  FROM reputation_scores WHERE sample_size < 0
  UNION ALL
  SELECT id, 'reputation_scores.state_score_band_incoherent'
  FROM reputation_scores
  WHERE NOT (
    (state = 'insufficient_data' AND composite_score IS NULL AND score_band IS NULL)
    OR
    (state = 'ok' AND composite_score IS NOT NULL AND score_band IS NOT NULL
      AND sample_size >= 30)
  )
  UNION ALL
  SELECT id, 'reputation_scores.score_band_threshold_incoherent'
  FROM reputation_scores
  WHERE composite_score IS NOT NULL AND score_band IS NOT NULL
    AND NOT (
      (score_band = 'red' AND composite_score < 80)
      OR (score_band = 'amber' AND composite_score >= 80 AND composite_score < 95)
      OR (score_band = 'green' AND composite_score >= 95)
    )
)
SELECT id, category
FROM violations
ORDER BY category, id;
