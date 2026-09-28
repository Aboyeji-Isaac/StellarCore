-- CreateEnum
CREATE TYPE "rate_capture_run_outcome" AS ENUM ('succeeded', 'partial', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "rate_capture_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" TEXT NOT NULL,
    "contract_version" INTEGER NOT NULL,
    "configuration_fingerprint" TEXT NOT NULL,
    "scheduler" TEXT NOT NULL,
    "scheduled_interval_ms" INTEGER,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "outcome" "rate_capture_run_outcome" NOT NULL DEFAULT 'skipped',
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "succeeded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failure_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "rate_capture_runs_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "rate_snapshots" ADD COLUMN "capture_run_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "rate_capture_runs_run_id_key" ON "rate_capture_runs"("run_id");

-- CreateIndex
CREATE INDEX "rate_capture_runs_started_at_idx" ON "rate_capture_runs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "rate_capture_runs_outcome_completed_at_idx" ON "rate_capture_runs"("outcome", "completed_at" DESC);

-- CreateIndex
CREATE INDEX "rate_snapshots_capture_run_id_idx" ON "rate_snapshots"("capture_run_id");

-- AddForeignKey
ALTER TABLE "rate_snapshots" ADD CONSTRAINT "rate_snapshots_capture_run_id_fkey" FOREIGN KEY ("capture_run_id") REFERENCES "rate_capture_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
