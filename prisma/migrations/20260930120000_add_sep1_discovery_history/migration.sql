-- SEP-1 discovery history and review gate.
-- Additive only: no rows are inserted, so legacy anchors have NO approved
-- baseline (unavailable) until an operator approves a newly observed digest.
-- Historical baselines are never reconstructed from current TOML.

-- CreateEnum
CREATE TYPE "sep1_observation_assessment" AS ENUM ('NO_BASELINE', 'MATCHES_BASELINE', 'CHANGED_UNREVIEWED');

-- CreateEnum
CREATE TYPE "sep1_review_decision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "sep1_discovery_observations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "canonical_version" INTEGER NOT NULL,
    "digest" CHAR(64) NOT NULL,
    "sensitive_digest" CHAR(64) NOT NULL,
    "toml_url" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "assessment" "sep1_observation_assessment" NOT NULL,
    "diff" JSONB NOT NULL,
    "baseline_review_id" UUID,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sep1_discovery_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sep1_discovery_observations_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$' AND "sensitive_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "sep1_discovery_observations_version_check" CHECK ("canonical_version" > 0)
);

-- CreateTable
CREATE TABLE "sep1_metadata_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "observation_id" UUID NOT NULL,
    "observation_digest" CHAR(64) NOT NULL,
    "sensitive_digest" CHAR(64) NOT NULL,
    "decision" "sep1_review_decision" NOT NULL,
    "actor" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reviewed_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sep1_metadata_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sep1_metadata_reviews_digest_check" CHECK ("observation_digest" ~ '^[0-9a-f]{64}$' AND "sensitive_digest" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "sep1_metadata_reviews_text_check" CHECK (
      char_length(btrim("actor")) BETWEEN 1 AND 100
      AND char_length(btrim("reference")) BETWEEN 1 AND 200
      AND char_length(btrim("reason")) BETWEEN 1 AND 1000
    )
);

-- CreateIndex
CREATE INDEX "sep1_discovery_observations_anchor_fetched_idx" ON "sep1_discovery_observations"("anchor_id", "fetched_at" DESC);

-- CreateIndex
CREATE INDEX "sep1_discovery_observations_anchor_digest_idx" ON "sep1_discovery_observations"("anchor_id", "digest");

-- CreateIndex
CREATE INDEX "sep1_metadata_reviews_anchor_decision_reviewed_idx" ON "sep1_metadata_reviews"("anchor_id", "decision", "reviewed_at" DESC);

-- AddForeignKey
ALTER TABLE "sep1_discovery_observations" ADD CONSTRAINT "sep1_discovery_observations_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sep1_discovery_observations" ADD CONSTRAINT "sep1_discovery_observations_baseline_review_id_fkey" FOREIGN KEY ("baseline_review_id") REFERENCES "sep1_metadata_reviews"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sep1_metadata_reviews" ADD CONSTRAINT "sep1_metadata_reviews_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sep1_metadata_reviews" ADD CONSTRAINT "sep1_metadata_reviews_observation_id_fkey" FOREIGN KEY ("observation_id") REFERENCES "sep1_discovery_observations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Append-only enforcement: history rows can never be updated or deleted.
CREATE FUNCTION "sep1_history_reject_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: SEP-1 history is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "sep1_discovery_observations_append_only"
  BEFORE UPDATE OR DELETE ON "sep1_discovery_observations"
  FOR EACH ROW EXECUTE FUNCTION "sep1_history_reject_mutation"();

CREATE TRIGGER "sep1_metadata_reviews_append_only"
  BEFORE UPDATE OR DELETE ON "sep1_metadata_reviews"
  FOR EACH ROW EXECUTE FUNCTION "sep1_history_reject_mutation"();
