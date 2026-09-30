import type { CronNonceStore } from "@/lib/scheduled/signedCronAuth";

/**
 * PostgreSQL-backed nonce store, shared by every instance. The nonce is the
 * primary key, so INSERT ... ON CONFLICT DO NOTHING lets exactly one of any
 * number of concurrent replays win. Expired rows are deleted on each call,
 * which bounds the table to the nonces of the last replay window.
 */
export const PRISMA_CRON_NONCE_STORE: CronNonceStore = Object.freeze({
  async reserve(nonce, expiresAt, now) {
    const { db } = await import("@/lib/dbClient");
    await db.cronNonce.deleteMany({ where: { expiresAt: { lt: now } } });
    const { count } = await db.cronNonce.createMany({
      data: [{ nonce, expiresAt }],
      skipDuplicates: true,
    });
    return count === 1;
  },
});
