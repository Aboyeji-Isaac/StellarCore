-- CreateEnum
CREATE TYPE "rate_anomaly_status" AS ENUM ('consistent', 'quarantined', 'insufficient_peers', 'unassessable');

-- CreateTable
CREATE TABLE "rate_anomaly_assessments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "snapshot_id" UUID NOT NULL,
    "status" "rate_anomaly_status" NOT NULL,
    "reason" TEXT,
    "criterion_version" TEXT NOT NULL,
    "baseline_rate" DECIMAL(38,18),
    "tolerance_bps" INTEGER NOT NULL,
    "contemporaneity_window_ms" INTEGER NOT NULL,
    "independent_peer_count" INTEGER NOT NULL,
    "agreeing_peer_count" INTEGER NOT NULL,
    "peer_snapshot_ids" UUID[],
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rate_anomaly_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_anomaly_assessments_latest_idx" ON "rate_anomaly_assessments"("snapshot_id", "assessed_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "rate_anomaly_assessments_status_idx" ON "rate_anomaly_assessments"("status", "assessed_at" DESC);

-- AddForeignKey
ALTER TABLE "rate_anomaly_assessments" ADD CONSTRAINT "rate_anomaly_assessments_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
