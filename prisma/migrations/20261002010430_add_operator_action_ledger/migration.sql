-- CreateEnum
CREATE TYPE "registry_lifecycle_state" AS ENUM ('ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "operator_actor_type" AS ENUM ('SYSTEM', 'HUMAN');

-- CreateEnum
CREATE TYPE "operator_action_mode" AS ENUM ('DRY_RUN', 'APPLIED');

-- CreateEnum
CREATE TYPE "operator_target_type" AS ENUM ('RATE_SNAPSHOT', 'ANCHOR');

-- CreateEnum
CREATE TYPE "operator_action_type" AS ENUM ('RATE_SNAPSHOT_INVALIDATED', 'RATE_SNAPSHOT_SUPERSEDED', 'RATE_DISPOSITION_RECOVERED', 'ANCHOR_RETIRED', 'ANCHOR_REACTIVATED');

-- CreateEnum
CREATE TYPE "operator_reason_code" AS ENUM ('SOURCE_ERROR', 'DUPLICATE_OBSERVATION', 'STALE_ARTIFACT', 'DATA_CORRECTION', 'REVIEWED_CONFIGURATION_REMOVAL', 'OPERATOR_RECOVERY', 'OTHER_REVIEWED');

-- CreateEnum
CREATE TYPE "rate_snapshot_disposition_type" AS ENUM ('INVALIDATED', 'SUPERSEDED');

-- AlterTable
ALTER TABLE "anchors" ADD COLUMN     "lifecycle_state" "registry_lifecycle_state" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "retired_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "operator_actions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "action_id" TEXT NOT NULL,
    "action_type" "operator_action_type" NOT NULL,
    "mode" "operator_action_mode" NOT NULL DEFAULT 'APPLIED',
    "target_type" "operator_target_type" NOT NULL,
    "target_id" TEXT NOT NULL,
    "target_label" TEXT,
    "reason_code" "operator_reason_code" NOT NULL,
    "rationale" TEXT,
    "actor_type" "operator_actor_type" NOT NULL,
    "actor_id" TEXT,
    "run_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_snapshot_dispositions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "disposition" "rate_snapshot_disposition_type" NOT NULL,
    "reason_code" "operator_reason_code" NOT NULL,
    "rationale" TEXT,
    "actor_type" "operator_actor_type" NOT NULL,
    "actor_id" TEXT,
    "run_id" TEXT,
    "action_record_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_snapshot_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "operator_actions_action_id_key" ON "operator_actions"("action_id");

-- CreateIndex
CREATE INDEX "operator_actions_target_idx" ON "operator_actions"("target_type", "target_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "operator_actions_run_id_idx" ON "operator_actions"("run_id");

-- CreateIndex
CREATE INDEX "operator_actions_action_type_idx" ON "operator_actions"("action_type", "created_at" DESC);

-- CreateIndex
CREATE INDEX "operator_actions_actor_type_idx" ON "operator_actions"("actor_type", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "rate_snapshot_dispositions_snapshot_id_key" ON "rate_snapshot_dispositions"("snapshot_id");

-- CreateIndex
CREATE INDEX "rate_snapshot_dispositions_type_idx" ON "rate_snapshot_dispositions"("disposition");

-- AddForeignKey
ALTER TABLE "rate_snapshot_dispositions" ADD CONSTRAINT "rate_snapshot_dispositions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_snapshot_dispositions" ADD CONSTRAINT "rate_snapshot_dispositions_action_record_id_fkey" FOREIGN KEY ("action_record_id") REFERENCES "operator_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Bounded columns: the write path validates these too, and the database
-- enforces the same finite limits so an out-of-band insert cannot store an
-- unbounded rationale, label, or correlation id.
ALTER TABLE "operator_actions"
  ADD CONSTRAINT "operator_actions_action_id_length_check"
    CHECK (char_length("action_id") BETWEEN 1 AND 100),
  ADD CONSTRAINT "operator_actions_target_id_length_check"
    CHECK (char_length("target_id") BETWEEN 1 AND 200),
  ADD CONSTRAINT "operator_actions_target_label_length_check"
    CHECK ("target_label" IS NULL OR char_length("target_label") BETWEEN 1 AND 200),
  ADD CONSTRAINT "operator_actions_rationale_length_check"
    CHECK ("rationale" IS NULL OR char_length("rationale") <= 500),
  ADD CONSTRAINT "operator_actions_actor_id_length_check"
    CHECK ("actor_id" IS NULL OR char_length("actor_id") BETWEEN 1 AND 200),
  ADD CONSTRAINT "operator_actions_run_id_length_check"
    CHECK ("run_id" IS NULL OR char_length("run_id") BETWEEN 1 AND 100),
  -- A persisted ledger row always describes an applied action.
  ADD CONSTRAINT "operator_actions_mode_applied_check"
    CHECK ("mode" = 'APPLIED'),
  -- Actor identity is truthful: a system action has no human identity, and a
  -- human action must carry the authenticated identity supplied by its caller.
  ADD CONSTRAINT "operator_actions_actor_identity_check"
    CHECK (
      ("actor_type" = 'SYSTEM' AND "actor_id" IS NULL)
      OR ("actor_type" = 'HUMAN' AND "actor_id" IS NOT NULL)
    );

-- Immutability: ledger rows are append-only and the database refuses any
-- update, delete, or truncate through any path, including normal repository
-- interfaces and direct SQL.
CREATE OR REPLACE FUNCTION prevent_operator_action_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator_actions is an append-only audit ledger'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER operator_actions_append_only
BEFORE UPDATE OR DELETE ON "operator_actions"
FOR EACH ROW
EXECUTE FUNCTION prevent_operator_action_mutation();

CREATE TRIGGER operator_actions_no_truncate
BEFORE TRUNCATE ON "operator_actions"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_operator_action_mutation();
