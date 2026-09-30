-- CreateEnum
CREATE TYPE "refresh_run_outcome" AS ENUM ('successful', 'partial', 'failed');

-- CreateTable
CREATE TABLE "refresh_watchdog" (
    "pipeline" TEXT NOT NULL,
    "tracking_since" TIMESTAMPTZ(6) NOT NULL,
    "last_run_id" UUID,
    "last_run_started_at" TIMESTAMPTZ(6),
    "last_run_completed_at" TIMESTAMPTZ(6),
    "last_run_outcome" "refresh_run_outcome",
    "last_run_failure_code" TEXT,
    "last_successful_refresh_at" TIMESTAMPTZ(6),
    "consecutive_unsuccessful_runs" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_watchdog_pkey" PRIMARY KEY ("pipeline")
);

-- Start tracking at deployment so a scheduler that never runs becomes
-- detectably stale after the first missed slot plus grace (issue #189).
INSERT INTO "refresh_watchdog" ("pipeline", "tracking_since")
VALUES ('scheduled-refresh', CURRENT_TIMESTAMP)
ON CONFLICT ("pipeline") DO NOTHING;
