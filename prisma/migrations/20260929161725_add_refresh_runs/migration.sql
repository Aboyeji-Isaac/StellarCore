-- CreateEnum
CREATE TYPE "refresh_run_state" AS ENUM ('running', 'succeeded', 'partially_succeeded', 'failed');

-- CreateEnum
CREATE TYPE "refresh_phase_state" AS ENUM ('pending', 'running', 'succeeded', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "refresh_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "triggered_by" VARCHAR(32) NOT NULL DEFAULT 'cron',
    "state" "refresh_run_state" NOT NULL DEFAULT 'running',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "resumed_from_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "phase_states" JSONB NOT NULL DEFAULT '{}',
    "failures" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,

    CONSTRAINT "refresh_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_runs_state_started_at_idx" ON "refresh_runs"("state", "started_at" DESC);
