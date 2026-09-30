import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { assessCorridorAnomalies } from "@/lib/rates/anomalyAssessment";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_RATE_ANOMALY_DATABASE_INTEGRATION === "1";

test("quarantine is persisted append-only and excluded by the database read path", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const corridorSlug = `anomaly-${suffix}`;
  const capturedAt = new Date();
  const anchorIds: string[] = [];
  let corridorId: string | undefined;

  try {
    const corridor = await db.corridor.create({
      data: { slug: corridorSlug, assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR" },
      select: { id: true },
    });
    corridorId = corridor.id;
    const rates = { a: "5.4", b: "5.42", c: "5.38", x: "540" } as const;
    const snapshotIds: Record<string, string> = {};
    for (const [key, rate] of Object.entries(rates)) {
      const anchor = await db.anchor.create({
        data: {
          slug: `anomaly-${key}-${suffix}`,
          name: `Anomaly ${key}`,
          homeDomain: `${key}.${suffix}.example.com`,
          tomlUrl: `https://${key}.${suffix}.example.com/.well-known/stellar.toml`,
        },
        select: { id: true },
      });
      anchorIds.push(anchor.id);
      await db.anchorCorridor.create({ data: { anchorId: anchor.id, corridorId: corridor.id } });
      const snapshot = await db.rateSnapshot.create({
        data: {
          anchorId: anchor.id, corridorId: corridor.id, rate, sourceAmount: "100",
          destinationAmount: rate, fee: "0", capturedAt,
        },
        select: { id: true },
      });
      snapshotIds[key] = snapshot.id;
    }

    const first = await assessCorridorAnomalies([corridorSlug], { now: () => capturedAt });
    assert.deepEqual(first.failures, []);
    assert.equal(first.assessmentsAppended, 4);
    assert.deepEqual(first.quarantined.map(({ snapshotId }) => snapshotId), [snapshotIds.x]);

    const second = await assessCorridorAnomalies([corridorSlug], { now: () => capturedAt });
    assert.equal(second.assessmentsAppended, 0);

    const read = await readLatestCorridorRate(corridorSlug, { evaluatedAt: capturedAt });
    assert.ok(read.ok);
    assert.equal(read.median, "5.4");
    assert.equal(read.freshSourceCount, 3);
    const outlier = read.observations.find(({ snapshotId }) => snapshotId === snapshotIds.x);
    assert.equal(outlier?.rate, "540");
    assert.equal(outlier?.exclusionReason, "quarantined");
    assert.deepEqual(outlier?.anomaly, {
      status: "quarantined", reason: "deviates_from_peer_consensus", origin: "persisted",
    });

    const stored = await db.rateAnomalyAssessment.findFirstOrThrow({
      where: { snapshotId: snapshotIds.x },
    });
    assert.equal(stored.baselineRate?.toString(), "5.4");
    assert.deepEqual([...stored.peerSnapshotIds].sort(), [snapshotIds.a, snapshotIds.b, snapshotIds.c].sort());
    const raw = await db.rateSnapshot.findUniqueOrThrow({ where: { id: snapshotIds.x } });
    assert.equal(raw.rate.toString(), "540");
  } finally {
    if (corridorId) {
      await db.rateAnomalyAssessment.deleteMany({ where: { snapshot: { corridorId } } });
      await db.rateSnapshot.deleteMany({ where: { corridorId } });
      await db.anchorCorridor.deleteMany({ where: { corridorId } });
      await db.corridor.delete({ where: { id: corridorId } });
    }
    if (anchorIds.length > 0) await db.anchor.deleteMany({ where: { id: { in: anchorIds } } });
  }
});
