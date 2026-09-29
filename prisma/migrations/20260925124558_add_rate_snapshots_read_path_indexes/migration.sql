-- CreateIndex
CREATE INDEX "rate_snapshots_latest_observation_idx" ON "rate_snapshots"("corridor_id", "anchor_id", "captured_at" DESC, "id" DESC, "rate", "source_amount", "destination_amount", "fee");

-- CreateIndex
CREATE INDEX "rate_snapshots_anchor_corridor_latest_idx" ON "rate_snapshots"("anchor_id", "corridor_id", "captured_at" DESC, "id" DESC);
