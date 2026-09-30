-- Bounded per-anchor health evidence for deterministic anchor availability
-- transitions (issue #165). Counters and timestamps only, one row per anchor,
-- cascading deletion with its anchor. Existing anchors keep their current
-- published status; health evidence accumulates from the next sync run.

-- CreateTable
CREATE TABLE "anchor_health_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "status" "anchor_status" NOT NULL,
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "last_failure_class" TEXT,
    "last_failure_code" TEXT,
    "consecutive_successes" INTEGER NOT NULL DEFAULT 0,
    "last_observed_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "last_transition_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchor_health_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anchor_health_states_anchor_id_key" ON "anchor_health_states"("anchor_id");

-- AddForeignKey
ALTER TABLE "anchor_health_states" ADD CONSTRAINT "anchor_health_states_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
