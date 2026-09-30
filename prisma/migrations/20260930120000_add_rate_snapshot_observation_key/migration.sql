-- AlterTable
ALTER TABLE "rate_snapshots" ADD COLUMN "observation_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "rate_snapshots_observation_key_key" ON "rate_snapshots"("observation_key");
