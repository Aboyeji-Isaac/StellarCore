import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { NormalizedRateObservation } from "@/types/rates";

const ENABLED = process.env.RUN_RATE_RETRY_DATABASE_INTEGRATION === "1";

test("rate-capture retries persist one row per logical observation", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { persistRateSnapshot } = await import("@/lib/rates/snapshot");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-retry-${suffix}`;
  const corridorSlug = `test-retry-corridor-${suffix}`;
  let anchorId: string | undefined;
  let corridorId: string | undefined;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Retry Idempotency Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
      },
      select: { id: true },
    });
    const corridor = await db.corridor.create({
      data: {
        slug: corridorSlug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "USD",
        countryTo: "US",
      },
      select: { id: true },
    });
    anchorId = anchor.id;
    corridorId = corridor.id;
    await db.anchorCorridor.create({
      data: { anchorId: anchor.id, corridorId: corridor.id },
    });

    const observation: NormalizedRateObservation = Object.freeze({
      anchorSlug,
      corridorSlug,
      rate: "1.01",
      sourceAmount: "100",
      destinationAmount: "101",
      fee: "1",
      capturedAt: new Date("2026-08-27T12:00:00.000Z"),
      configurationFingerprint: "test-fingerprint",
    });
    const countRows = () =>
      db.rateSnapshot.count({ where: { anchorId: anchor.id, corridorId: corridor.id } });

    // Same logical observation, retried: persisted once, outcome deterministic.
    const first = await persistRateSnapshot(observation);
    const retry = await persistRateSnapshot(observation);
    const retryAgain = await persistRateSnapshot(observation);
    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(retryAgain.ok, true);
    assert.equal(await countRows(), 1, "retrying the same observation must not add rows");
    if (first.ok && retry.ok && retryAgain.ok) {
      assert.equal(retry.snapshot.id, first.snapshot.id);
      assert.equal(retryAgain.snapshot.id, first.snapshot.id);
    }

    // A genuinely new observation (same numeric rate, new capture time) still persists.
    const next = await persistRateSnapshot({
      ...observation,
      capturedAt: new Date("2026-08-27T12:01:00.000Z"),
    });
    assert.equal(next.ok, true);
    assert.equal(await countRows(), 2, "a distinct observation must still be persisted");
  } finally {
    if (anchorId && corridorId) {
      await db.rateSnapshot.deleteMany({ where: { anchorId, corridorId } });
      await db.anchorCorridor.deleteMany({ where: { anchorId, corridorId } });
    }
    if (anchorId) await db.anchor.deleteMany({ where: { id: anchorId } });
    if (corridorId) await db.corridor.deleteMany({ where: { id: corridorId } });
    await db.$disconnect();
  }
});
