CREATE TABLE "reputation_evaluations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "anchor_id" UUID NOT NULL,
  "algorithm_version" TEXT NOT NULL,
  "is_legacy" BOOLEAN NOT NULL DEFAULT false,
  "state" "reputation_state" NOT NULL,
  "composite_score" DOUBLE PRECISION,
  "score_band" "reputation_score_band",
  "availability_weight" INTEGER,
  "availability_score" INTEGER,
  "availability_earned_points" INTEGER,
  "rate_freshness_weight" INTEGER,
  "rate_freshness_score" INTEGER,
  "rate_freshness_earned_points" INTEGER,
  "coverage_weight" INTEGER,
  "coverage_score" INTEGER,
  "coverage_earned_points" INTEGER,
  "transfer_reliability_weight" INTEGER,
  "transfer_reliability_score" INTEGER,
  "transfer_reliability_earned_points" INTEGER,
  "corridor_count" INTEGER,
  "latest_rate_count" INTEGER,
  "fresh_rate_count" INTEGER,
  "outcome_count" INTEGER,
  "completed_outcome_count" INTEGER,
  "minimum_outcome_count" INTEGER,
  "fill_rate_7d" DOUBLE PRECISION,
  "fill_rate_30d" DOUBLE PRECISION,
  "fill_rate_90d" DOUBLE PRECISION,
  "settle_p50_ms" INTEGER,
  "settle_p95_ms" INTEGER,
  "slippage_p50" DOUBLE PRECISION,
  "slippage_p95" DOUBLE PRECISION,
  "computed_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reputation_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reputation_evaluations_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "reputation_evaluations_state_coherent" CHECK (
    (state = 'insufficient_data' AND composite_score IS NULL AND score_band IS NULL)
    OR (state = 'ok' AND composite_score IS NOT NULL AND score_band IS NOT NULL)
  ),
  CONSTRAINT "reputation_evaluations_scores_bounded" CHECK (
    length(algorithm_version) BETWEEN 1 AND 64
    AND (composite_score IS NULL OR composite_score BETWEEN 0 AND 100)
    AND (availability_weight IS NULL OR availability_weight BETWEEN 0 AND 100)
    AND (availability_score IS NULL OR availability_score BETWEEN 0 AND 100)
    AND (availability_earned_points IS NULL OR availability_earned_points BETWEEN 0 AND 100)
    AND (rate_freshness_weight IS NULL OR rate_freshness_weight BETWEEN 0 AND 100)
    AND (rate_freshness_score IS NULL OR rate_freshness_score BETWEEN 0 AND 100)
    AND (rate_freshness_earned_points IS NULL OR rate_freshness_earned_points BETWEEN 0 AND 100)
    AND (coverage_weight IS NULL OR coverage_weight BETWEEN 0 AND 100)
    AND (coverage_score IS NULL OR coverage_score BETWEEN 0 AND 100)
    AND (coverage_earned_points IS NULL OR coverage_earned_points BETWEEN 0 AND 100)
    AND (transfer_reliability_weight IS NULL OR transfer_reliability_weight BETWEEN 0 AND 100)
    AND (transfer_reliability_score IS NULL OR transfer_reliability_score BETWEEN 0 AND 100)
    AND (transfer_reliability_earned_points IS NULL OR transfer_reliability_earned_points BETWEEN 0 AND 100)
  ),
  CONSTRAINT "reputation_evaluations_counts_bounded" CHECK (
    (corridor_count IS NULL OR corridor_count >= 0)
    AND (latest_rate_count IS NULL OR latest_rate_count >= 0)
    AND (fresh_rate_count IS NULL OR fresh_rate_count >= 0)
    AND (outcome_count IS NULL OR outcome_count >= 0)
    AND (completed_outcome_count IS NULL OR completed_outcome_count >= 0)
    AND (minimum_outcome_count IS NULL OR minimum_outcome_count >= 0)
    AND (fresh_rate_count IS NULL OR latest_rate_count IS NULL OR fresh_rate_count <= latest_rate_count)
    AND (completed_outcome_count IS NULL OR outcome_count IS NULL OR completed_outcome_count <= outcome_count)
  ),
  CONSTRAINT "reputation_evaluations_new_context_complete" CHECK (
    is_legacy OR (
      availability_weight IS NOT NULL AND availability_score IS NOT NULL AND availability_earned_points IS NOT NULL
      AND rate_freshness_weight IS NOT NULL AND rate_freshness_score IS NOT NULL AND rate_freshness_earned_points IS NOT NULL
      AND coverage_weight IS NOT NULL AND coverage_score IS NOT NULL AND coverage_earned_points IS NOT NULL
      AND transfer_reliability_weight IS NOT NULL AND transfer_reliability_score IS NOT NULL AND transfer_reliability_earned_points IS NOT NULL
      AND corridor_count IS NOT NULL AND latest_rate_count IS NOT NULL AND fresh_rate_count IS NOT NULL
      AND outcome_count IS NOT NULL AND completed_outcome_count IS NOT NULL AND minimum_outcome_count IS NOT NULL
    )
  )
);

CREATE INDEX "reputation_evaluations_anchor_history_idx"
  ON "reputation_evaluations"("anchor_id", "computed_at" DESC, "id" DESC);

-- Preserve exactly what the current projection knows. Component and detailed
-- evidence counts were not stored historically, so they deliberately remain NULL.
INSERT INTO "reputation_evaluations" (
  "anchor_id", "algorithm_version", "is_legacy", "state", "composite_score",
  "score_band", "outcome_count", "fill_rate_7d", "fill_rate_30d",
  "fill_rate_90d", "settle_p50_ms", "settle_p95_ms", "slippage_p50",
  "slippage_p95", "computed_at"
)
SELECT "anchor_id", 'legacy-unknown', true, "state", "composite_score",
  "score_band", "sample_size", "fill_rate_7d", "fill_rate_30d",
  "fill_rate_90d", "settle_p50_ms", "settle_p95_ms", "slippage_p50",
  "slippage_p95", "computed_at"
FROM "reputation_scores";

ALTER TABLE "reputation_scores" ADD COLUMN "evaluation_id" UUID;
UPDATE "reputation_scores" AS score
SET "evaluation_id" = evaluation.id
FROM "reputation_evaluations" AS evaluation
WHERE evaluation.anchor_id = score.anchor_id AND evaluation.is_legacy = true;
ALTER TABLE "reputation_scores" ALTER COLUMN "evaluation_id" SET NOT NULL;
CREATE UNIQUE INDEX "reputation_scores_evaluation_id_key" ON "reputation_scores"("evaluation_id");
ALTER TABLE "reputation_scores" ADD CONSTRAINT "reputation_scores_evaluation_id_fkey"
  FOREIGN KEY ("evaluation_id") REFERENCES "reputation_evaluations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION reject_reputation_evaluation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reputation evaluations are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reputation_evaluations_reject_update"
  BEFORE UPDATE ON "reputation_evaluations"
  FOR EACH ROW EXECUTE FUNCTION reject_reputation_evaluation_mutation();
CREATE TRIGGER "reputation_evaluations_reject_delete"
  BEFORE DELETE ON "reputation_evaluations"
  FOR EACH ROW EXECUTE FUNCTION reject_reputation_evaluation_mutation();
