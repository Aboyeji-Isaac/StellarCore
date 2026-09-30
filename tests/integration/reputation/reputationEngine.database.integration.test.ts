import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

test("isolated database evidence persists one current ReputationScore row", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-reputation-${suffix}`;
  const corridorSlug = `test-reputation-corridor-${suffix}`;
  const evaluatedAt = new Date();

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Reputation Integration Fixture",
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
    await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridor.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: evaluatedAt,
      },
    });
    await db.transferOutcome.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        anchorId: anchor.id,
        corridorId: corridor.id,
        status: index < 27 ? "COMPLETED" as const : "ERROR" as const,
        fillRate: index < 27 ? "0.999999999999999999" : "0",
        settlementMs: 1_000,
        slippage: index === 0
          ? "0.000000000000000001"
          : index < 27 ? "0.123456789012345678" : "0",
        recordedAt: new Date(evaluatedAt.getTime() - index * 1_000),
      })),
    });

    const before = await db.reputationScore.count({ where: { anchorId: anchor.id } });
    const first = await evaluateAnchorReputation(anchorSlug, { evaluatedAt });
    const second = await evaluateAnchorReputation(anchorSlug, {
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
    });
    const after = await db.reputationScore.count({ where: { anchorId: anchor.id } });
    const persistedMetrics = await db.reputationScore.findUnique({
      where: { anchorId: anchor.id },
      select: { fillRate90d: true, slippageP50: true, slippageP95: true },
    });
    const persistedOutcome = await db.transferOutcome.findFirst({
      where: { anchorId: anchor.id },
      orderBy: { recordedAt: "desc" },
      select: { fillRate: true, slippage: true },
    });

    assert.equal(before, 0);
    assert.equal(after, 1);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.calculation.score, 95);
      assert.equal(first.calculation.metrics.slippageP50, "0.123456789012345678");
      assert.equal(first.calculation.metrics.slippageP95, "0.123456789012345678");
      assert.deepEqual(
        first.calculation.metrics,
        second.calculation.metrics,
      );
      assert.equal(first.persisted?.id, second.persisted?.id);
    }
    assert.equal(persistedMetrics?.fillRate90d?.toString(), "0.9");
    assert.equal(persistedMetrics?.slippageP50?.toString(), "0.123456789012345678");
    assert.equal(persistedMetrics?.slippageP95?.toString(), "0.123456789012345678");
    assert.equal(persistedOutcome?.fillRate.toFixed(), "0.999999999999999999");
    assert.equal(persistedOutcome?.slippage.toFixed(), "0.000000000000000001");
  } finally {
    await db.reputationScore.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.transferOutcome.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});
