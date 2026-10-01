CREATE TYPE "scheduled_source_suppression_state" AS ENUM ('ACTIVE', 'SUPPRESSED');

CREATE TABLE "scheduled_source_suppressions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_slug" TEXT NOT NULL,
    "corridor_slug" TEXT NOT NULL,
    "state" "scheduled_source_suppression_state" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "failure_code" TEXT NOT NULL,
    "failure_phase" TEXT NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "first_failed_at" TIMESTAMPTZ(6) NOT NULL,
    "last_failed_at" TIMESTAMPTZ(6) NOT NULL,
    "suppressed_at" TIMESTAMPTZ(6),
    "reactivated_at" TIMESTAMPTZ(6),
    "reactivation_reason" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_source_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "scheduled_source_suppressions_source_key"
ON "scheduled_source_suppressions"("anchor_slug", "corridor_slug");

CREATE INDEX "scheduled_source_suppressions_state_idx"
ON "scheduled_source_suppressions"("state");

ALTER TABLE "scheduled_source_suppressions"
ADD CONSTRAINT "scheduled_source_suppressions_consecutive_failures_check"
CHECK ("consecutive_failures" >= 0);
