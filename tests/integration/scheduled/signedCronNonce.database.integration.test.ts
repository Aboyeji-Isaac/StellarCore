import assert from "node:assert/strict";
import test from "node:test";

import {
  CRON_MAX_PAST_SKEW_SECONDS,
  signCronRequest,
  verifySignedCronRequest,
} from "@/lib/scheduled/signedCronAuth";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_SIGNED_CRON_DATABASE_INTEGRATION === "1";

test("nonce reservation is atomic across connections and retention is bounded", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { PRISMA_CRON_NONCE_STORE } = await import("@/lib/scheduled/cronNonceStore");
  const secret = "integration-test-cron-secret";
  const path = "/api/internal/cron/refresh";
  const now = new Date();
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  const prefix = `it${Date.now().toString(36)}`;
  const request = (nonce: string, timestampSeconds = nowSeconds) => new Request(`http://localhost${path}`, {
    headers: signCronRequest({ method: "GET", pathAndQuery: path, secret, timestampSeconds, nonce }),
  });
  const verify = (req: Request, at = now) =>
    verifySignedCronRequest(req, { secret, nonceStore: PRISMA_CRON_NONCE_STORE, now: at });

  try {
    // 25 concurrent replays of one identical signed request: exactly one wins.
    const racing = await Promise.all(
      Array.from({ length: 25 }, () => verify(request(`${prefix}-race-0000000`))),
    );
    assert.equal(racing.filter(({ ok }) => ok).length, 1);
    assert.ok(racing.every((result) => result.ok || result.reason === "REPLAYED"));

    // The winner stays rejected afterwards, until its window has closed.
    assert.deepEqual(await verify(request(`${prefix}-race-0000000`)), { ok: false, reason: "REPLAYED" });

    // Retention is bounded: once the replay window passes, the next
    // reservation removes the expired nonce and the table does not grow.
    const later = new Date(now.getTime() + (CRON_MAX_PAST_SKEW_SECONDS + 5) * 1_000);
    const laterSeconds = Math.floor(later.getTime() / 1_000);
    assert.deepEqual(await verify(request(`${prefix}-later-000000`, laterSeconds), later), { ok: true });
    const remaining = await db.cronNonce.findMany({
      where: { nonce: { startsWith: prefix } },
      select: { nonce: true, expiresAt: true },
    });
    assert.deepEqual(remaining.map(({ nonce }) => nonce), [`${prefix}-later-000000`]);
    assert.ok(remaining[0]!.expiresAt.getTime() - later.getTime() <= (CRON_MAX_PAST_SKEW_SECONDS + 1) * 1_000);
  } finally {
    await db.cronNonce.deleteMany({ where: { nonce: { startsWith: prefix } } });
    await db.$disconnect();
  }
});
