-- CreateEnum
CREATE TYPE "anchor_status" AS ENUM ('LIVE', 'DEGRADED', 'DOWN', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "transfer_status" AS ENUM ('COMPLETED', 'PARTIAL', 'REFUNDED', 'EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "reputation_score_band" AS ENUM ('green', 'amber', 'red');

-- CreateEnum
CREATE TYPE "reputation_state" AS ENUM ('insufficient_data', 'ok');

-- CreateTable
CREATE TABLE "anchors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "home_domain" TEXT NOT NULL,
    "toml_url" TEXT NOT NULL,
    "seps" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "is_transfer_capable" BOOLEAN NOT NULL DEFAULT false,
    "status" "anchor_status" NOT NULL DEFAULT 'UNKNOWN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corridors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "asset_code_from" TEXT NOT NULL,
    "country_from" TEXT NOT NULL,
    "asset_code_to" TEXT NOT NULL,
    "country_to" TEXT NOT NULL,
    "slug" TEXT NOT NULL,

    CONSTRAINT "corridors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anchor_corridors" (
    "anchor_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,

    CONSTRAINT "anchor_corridors_pkey" PRIMARY KEY ("anchor_id","corridor_id")
);

-- CreateTable
CREATE TABLE "rate_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "rate" DECIMAL(38,18) NOT NULL,
    "source_amount" DECIMAL(38,18) NOT NULL,
    "destination_amount" DECIMAL(38,18) NOT NULL,
    "fee" DECIMAL(38,18) NOT NULL DEFAULT 0,
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transfer_outcomes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "corridor_id" UUID NOT NULL,
    "status" "transfer_status" NOT NULL,
    "fill_rate" DOUBLE PRECISION NOT NULL,
    "settlement_ms" INTEGER NOT NULL,
    "slippage" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reputation_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anchor_id" UUID NOT NULL,
    "composite_score" DOUBLE PRECISION,
    "score_band" "reputation_score_band",
    "fill_rate_7d" DOUBLE PRECISION,
    "fill_rate_30d" DOUBLE PRECISION,
    "fill_rate_90d" DOUBLE PRECISION,
    "settle_p50_ms" INTEGER,
    "settle_p95_ms" INTEGER,
    "slippage_p50" DOUBLE PRECISION,
    "slippage_p95" DOUBLE PRECISION,
    "sample_size" INTEGER NOT NULL DEFAULT 0,
    "state" "reputation_state" NOT NULL DEFAULT 'insufficient_data',
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reputation_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "anchors_slug_key" ON "anchors"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "corridors_slug_key" ON "corridors"("slug");

-- CreateIndex
CREATE INDEX "anchor_corridors_corridor_id_idx" ON "anchor_corridors"("corridor_id");

-- CreateIndex
CREATE INDEX "rate_snapshots_corridor_id_captured_at_idx" ON "rate_snapshots"("corridor_id", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "rate_snapshots_anchor_id_captured_at_idx" ON "rate_snapshots"("anchor_id", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "transfer_outcomes_anchor_id_recorded_at_idx" ON "transfer_outcomes"("anchor_id", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "reputation_scores_anchor_id_key" ON "reputation_scores"("anchor_id");

-- AddForeignKey
ALTER TABLE "anchor_corridors" ADD CONSTRAINT "anchor_corridors_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anchor_corridors" ADD CONSTRAINT "anchor_corridors_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_snapshots" ADD CONSTRAINT "rate_snapshots_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_snapshots" ADD CONSTRAINT "rate_snapshots_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_outcomes" ADD CONSTRAINT "transfer_outcomes_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfer_outcomes" ADD CONSTRAINT "transfer_outcomes_corridor_id_fkey" FOREIGN KEY ("corridor_id") REFERENCES "corridors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reputation_scores" ADD CONSTRAINT "reputation_scores_anchor_id_fkey" FOREIGN KEY ("anchor_id") REFERENCES "anchors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
