import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

test("repeated evaluations append history and atomically advance one current projection", {
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
    const first = await evaluateAnchorReputation(anchorSlug, { evaluatedAt });
    const second = await evaluateAnchorReputation(anchorSlug, {
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
    });
    const after = await db.reputationScore.count({ where: { anchorId: anchor.id } });
    const history = await db.reputationEvaluation.findMany({
      where: { anchorId: anchor.id },
      orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    });
    const projection = await db.reputationScore.findUniqueOrThrow({
      where: { anchorId: anchor.id },
    });

    assert.equal(before, 0);
    assert.equal(after, 1);
    assert.equal(history.length, 2);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.calculation.score, 95);
      assert.equal(first.persisted?.id, second.persisted?.id);
      assert.notEqual(first.persisted?.evaluationId, second.persisted?.evaluationId);
      assert.equal(projection.evaluationId, history[0]?.id);
      assert.equal(history[0]?.algorithmVersion, "reputation-v1");
      assert.equal(history[0]?.outcomeCount, 30);
    }
    await assert.rejects(
      db.reputationEvaluation.update({
        where: { id: history[0]!.id },
        data: { algorithmVersion: "tampered" },
      }),
      /append-only/,
    );
    await assert.rejects(
      db.reputationEvaluation.delete({ where: { id: history[0]!.id } }),
      /append-only/,
    );
    await db.$executeRawUnsafe(`
      CREATE FUNCTION test_reputation_projection_failure() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced projection failure'; END;
      $$ LANGUAGE plpgsql
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER "test_reputation_projection_failure"
      BEFORE INSERT OR UPDATE ON "reputation_scores"
      FOR EACH ROW WHEN (NEW.anchor_id = '${anchor.id}'::uuid)
      EXECUTE FUNCTION test_reputation_projection_failure()
    `);
    try {
      const failed = await evaluateAnchorReputation(anchorSlug, {
        evaluatedAt: new Date(evaluatedAt.getTime() + 2_000),
      });
      assert.equal(failed.ok, false);
      if (!failed.ok) assert.equal(failed.code, "PERSISTENCE_FAILURE");
      assert.equal(await db.reputationEvaluation.count({
        where: { anchorId: anchor.id },
      }), 2);
      assert.equal((await db.reputationScore.findUniqueOrThrow({
        where: { anchorId: anchor.id },
      })).evaluationId, projection.evaluationId);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER "test_reputation_projection_failure" ON "reputation_scores"');
      await db.$executeRawUnsafe("DROP FUNCTION test_reputation_projection_failure() ");
    }
  } finally {
    await db.reputationScore.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    // History is database-enforced append-only. Test fixtures are removed only
    // by temporarily disabling the trigger in this isolated integration DB.
    await db.$executeRawUnsafe('ALTER TABLE "reputation_evaluations" DISABLE TRIGGER "reputation_evaluations_reject_delete"');
    await db.reputationEvaluation.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.$executeRawUnsafe('ALTER TABLE "reputation_evaluations" ENABLE TRIGGER "reputation_evaluations_reject_delete"');
    await db.transferOutcome.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});
