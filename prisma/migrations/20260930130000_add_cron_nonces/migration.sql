-- CreateTable
CREATE TABLE "cron_nonces" (
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cron_nonces_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex
CREATE INDEX "cron_nonces_expires_at_idx" ON "cron_nonces"("expires_at");
