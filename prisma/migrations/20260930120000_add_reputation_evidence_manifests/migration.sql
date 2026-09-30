-- CreateEnum
CREATE TYPE "reputation_evidence_eligibility" AS ENUM ('eligible', 'excluded', 'outside_window');

-- CreateEnum
CREATE TYPE "reputation_evidence_reason_code" AS ENUM ('none', 'stale_rate', 'future_timestamp', 'invalid_timestamp', 'outside_outcome_window', 'invalidated_observation', 'unknown_authority', 'retired_or_non_member');

-- CreateEnum
CREATE TYPE "reputation_corridor_membership" AS ENUM ('member', 'retired', 'non_member');

-- CreateTable
CREATE TABLE "reputation_evidence_manifests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "reputation_score_id" UUID NOT NULL,
    "anchor_id" UUID NOT NULL,
    "anchor_status" "anchor_status" NOT NULL,
    "manifest_schema_version" INTEGER NOT NULL,
    "reason_code_vocabulary_version" INTEGER NOT NULL,
    "scoring_policy_version" TEXT NOT NULL,
    "freshness_policy_version" TEXT NOT NULL,
    "configuration_revision" TEXT NOT NULL,
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL,
    "outcome_window_start" TIMESTAMPTZ(6) NOT NULL,
    "corridor_count" INTEGER NOT NULL,
    "latest_rate_count" INTEGER NOT NULL,
    "fresh_rate_count" INTEGER NOT NULL,
    "outcome_count" INTEGER NOT NULL,
    "completed_outcome_count" INTEGER NOT NULL,
    "outside_outcome_count" INTEGER NOT NULL,
    "minimum_outcome_count" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reputation_evidence_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_evidence_corridor_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "manifest_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "membership" "reputation_corridor_membership" NOT NULL,
    "reason_code" "reputation_evidence_reason_code" NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "reputation_evidence_corridor_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_evidence_rate_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "manifest_id" UUID NOT NULL,
    "rate_snapshot_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,
    "age_ms" INTEGER,
    "eligibility" "reputation_evidence_eligibility" NOT NULL,
    "reason_code" "reputation_evidence_reason_code" NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "reputation_evidence_rate_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_evidence_outcome_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "manifest_id" UUID NOT NULL,
    "transfer_outcome_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "status" "transfer_status" NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "eligibility" "reputation_evidence_eligibility" NOT NULL,
    "reason_code" "reputation_evidence_reason_code" NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "reputation_evidence_outcome_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reputation_evidence_manifests_anchor_evaluated_idx" ON "reputation_evidence_manifests"("anchor_id", "evaluated_at" DESC);

-- CreateIndex
CREATE INDEX "reputation_evidence_manifests_score_evaluated_idx" ON "reputation_evidence_manifests"("reputation_score_id", "evaluated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_corridor_members_manifest_ordinal_key" ON "reputation_evidence_corridor_members"("manifest_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_corridor_members_manifest_corridor_key" ON "reputation_evidence_corridor_members"("manifest_id", "corridor_id");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_rate_members_manifest_ordinal_key" ON "reputation_evidence_rate_members"("manifest_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_rate_members_manifest_snapshot_key" ON "reputation_evidence_rate_members"("manifest_id", "rate_snapshot_id");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_outcome_members_manifest_ordinal_key" ON "reputation_evidence_outcome_members"("manifest_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "reputation_evidence_outcome_members_manifest_outcome_key" ON "reputation_evidence_outcome_members"("manifest_id", "transfer_outcome_id");

-- AddForeignKey
ALTER TABLE "reputation_evidence_manifests" ADD CONSTRAINT "reputation_evidence_manifests_reputation_score_id_fkey" FOREIGN KEY ("reputation_score_id") REFERENCES "reputation_scores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_manifests" ADD CONSTRAINT "reputation_evidence_manifests_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_corridor_members" ADD CONSTRAINT "reputation_evidence_corridor_members_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "reputation_evidence_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_corridor_members" ADD CONSTRAINT "reputation_evidence_corridor_members_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_rate_members" ADD CONSTRAINT "reputation_evidence_rate_members_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "reputation_evidence_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_rate_members" ADD CONSTRAINT "reputation_evidence_rate_members_rate_snapshot_id_fkey" FOREIGN KEY ("rate_snapshot_id") REFERENCES "rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_rate_members" ADD CONSTRAINT "reputation_evidence_rate_members_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_outcome_members" ADD CONSTRAINT "reputation_evidence_outcome_members_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "reputation_evidence_manifests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_outcome_members" ADD CONSTRAINT "reputation_evidence_outcome_members_transfer_outcome_id_fkey" FOREIGN KEY ("transfer_outcome_id") REFERENCES "transfer_outcomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_evidence_outcome_members" ADD CONSTRAINT "reputation_evidence_outcome_members_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutability guard: a manifest and its membership cannot be rewritten. The
-- database rejects UPDATE so a manifest can never be silently changed to
-- describe evidence other than what was read. The repository never issues an
-- update against these tables; this is defense in depth against out-of-band
-- writes. Deletes are left available for controlled maintenance and test
-- teardown, but are constrained by the restrictive foreign keys above.
CREATE OR REPLACE FUNCTION "reject_reputation_evidence_manifest_update"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reputation evidence manifests are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reputation_evidence_manifests_immutable"
  BEFORE UPDATE ON "reputation_evidence_manifests"
  FOR EACH ROW EXECUTE FUNCTION "reject_reputation_evidence_manifest_update"();

CREATE TRIGGER "reputation_evidence_corridor_members_immutable"
  BEFORE UPDATE ON "reputation_evidence_corridor_members"
  FOR EACH ROW EXECUTE FUNCTION "reject_reputation_evidence_manifest_update"();

CREATE TRIGGER "reputation_evidence_rate_members_immutable"
  BEFORE UPDATE ON "reputation_evidence_rate_members"
  FOR EACH ROW EXECUTE FUNCTION "reject_reputation_evidence_manifest_update"();

CREATE TRIGGER "reputation_evidence_outcome_members_immutable"
  BEFORE UPDATE ON "reputation_evidence_outcome_members"
  FOR EACH ROW EXECUTE FUNCTION "reject_reputation_evidence_manifest_update"();
