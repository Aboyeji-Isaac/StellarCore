import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

test("monotonic persistence rejects an older completion and keeps one current row", {
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
        fillRate: index < 27 ? 1 : 0,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: new Date(evaluatedAt.getTime() - index * 1_000),
      })),
    });

    const before = await db.reputationScore.count({ where: { anchorId: anchor.id } });
    let signalOlderWrite!: () => void;
    let releaseOlderWrite!: () => void;
    const olderWriteReached = new Promise<void>((resolve) => { signalOlderWrite = resolve; });
    const olderWriteGate = new Promise<void>((resolve) => { releaseOlderWrite = resolve; });
    const delayedRepository = Object.freeze({
      readEvidence: PRISMA_REPUTATION_REPOSITORY.readEvidence,
      upsertScore: async (input: Parameters<typeof PRISMA_REPUTATION_REPOSITORY.upsertScore>[0]) => {
        signalOlderWrite();
        await olderWriteGate;
        return PRISMA_REPUTATION_REPOSITORY.upsertScore(input);
      },
    });
    const olderEvaluation = evaluateAnchorReputation(anchorSlug, {
      evaluatedAt,
      repository: delayedRepository,
    });
    await olderWriteReached;
    const newer = await evaluateAnchorReputation(anchorSlug, {
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
    });
    releaseOlderWrite();
    const older = await olderEvaluation;
    const tied = await evaluateAnchorReputation(anchorSlug, {
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
    });
    const current = await db.reputationScore.findUnique({ where: { anchorId: anchor.id } });
    const after = await db.reputationScore.count({ where: { anchorId: anchor.id } });

    assert.equal(before, 0);
    assert.equal(after, 1);
    assert.equal(older.ok, true);
    assert.equal(newer.ok, true);
    assert.equal(tied.ok, true);
    if (older.ok && newer.ok && tied.ok) {
      assert.equal(older.calculation.score, 95);
      assert.equal(newer.persisted?.writeStatus, "written");
      assert.equal(older.persisted?.writeStatus, "rejected_stale");
      assert.equal(tied.persisted?.writeStatus, "rejected_tie");
      assert.equal(older.persisted?.id, newer.persisted?.id);
      assert.equal(newer.persisted?.id, tied.persisted?.id);
      assert.equal(
        current?.computedAt.toISOString(),
        new Date(evaluatedAt.getTime() + 1_000).toISOString(),
      );
    }
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
