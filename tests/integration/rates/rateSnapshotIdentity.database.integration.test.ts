import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { NormalizedRateObservation } from "@/types/rates";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_RATE_SNAPSHOT_IDENTITY_DATABASE_INTEGRATION === "1";

test("observation identity is enforced by the database across replays and concurrent runs", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { persistRateSnapshot } = await import("@/lib/rates/snapshot");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-identity-${suffix}`;
  const corridorSlug = `test-identity-corridor-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Observation Identity Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
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
    await db.anchorCorridor.create({
      data: { anchorId: anchor.id, corridorId: corridor.id },
    });
    const count = () => db.rateSnapshot.count({ where: { anchorId: anchor.id } });
    const observation = (capturedAt: string): NormalizedRateObservation => ({
      anchorSlug,
      corridorSlug,
      rate: "1.01",
      sourceAmount: "100",
      destinationAmount: "101",
      fee: "1",
      capturedAt: new Date(capturedAt),
    });

    const first = await persistRateSnapshot(observation("2026-09-01T00:00:00.000Z"));
    const replay = await persistRateSnapshot(observation("2026-09-01T00:00:00.000Z"));
    assert.ok(first.ok && replay.ok);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.snapshot.id, first.snapshot.id);
    assert.equal(await count(), 1);

    const distinct = await persistRateSnapshot(observation("2026-09-01T00:01:00.000Z"));
    assert.ok(distinct.ok);
    assert.equal(distinct.replayed, false);
    assert.equal(distinct.snapshot.rate, first.snapshot.rate);
    assert.equal(await count(), 2);

    const racing = await Promise.all(
      Array.from({ length: 10 }, () =>
        persistRateSnapshot(observation("2026-09-01T00:02:00.000Z"))),
    );
    assert.ok(racing.every((result) => result.ok));
    assert.equal(new Set(racing.map((r) => r.ok && r.snapshot.id)).size, 1);
    assert.equal(racing.filter((r) => r.ok && !r.replayed).length, 1);
    assert.equal(await count(), 3);
  } finally {
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});
