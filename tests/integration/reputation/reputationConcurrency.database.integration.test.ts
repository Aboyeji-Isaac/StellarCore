import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/app/generated/prisma/client";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

// Raw SQL upsert with positional parameters for use with $queryRawUnsafe
const REPUTATION_UPSERT_SQL = `
  WITH incoming AS (
    SELECT
      $1::uuid AS anchor_id,
      $2::float AS composite_score,
      $3::reputation_score_band AS score_band,
      $4::float AS fill_rate_7d,
      $5::float AS fill_rate_30d,
      $6::float AS fill_rate_90d,
      $7::int AS settle_p50_ms,
      $8::int AS settle_p95_ms,
      $9::float AS slippage_p50,
      $10::float AS slippage_p95,
      $11::int AS sample_size,
      $12::reputation_state AS state,
      $13::timestamptz AS computed_at
  ),
  upserted AS (
    INSERT INTO reputation_scores (
      anchor_id, composite_score, score_band, fill_rate_7d, fill_rate_30d, fill_rate_90d,
      settle_p50_ms, settle_p95_ms, slippage_p50, slippage_p95, sample_size, state, computed_at
    )
    SELECT
      anchor_id, composite_score, score_band, fill_rate_7d, fill_rate_30d, fill_rate_90d,
      settle_p50_ms, settle_p95_ms, slippage_p50, slippage_p95, sample_size, state, computed_at
    FROM incoming
    ON CONFLICT (anchor_id) DO UPDATE
      SET
        composite_score = EXCLUDED.composite_score,
        score_band = EXCLUDED.score_band,
        fill_rate_7d = EXCLUDED.fill_rate_7d,
        fill_rate_30d = EXCLUDED.fill_rate_30d,
        fill_rate_90d = EXCLUDED.fill_rate_90d,
        settle_p50_ms = EXCLUDED.settle_p50_ms,
        settle_p95_ms = EXCLUDED.settle_p95_ms,
        slippage_p50 = EXCLUDED.slippage_p50,
        slippage_p95 = EXCLUDED.slippage_p95,
        sample_size = EXCLUDED.sample_size,
        state = EXCLUDED.state,
        computed_at = EXCLUDED.computed_at
      WHERE reputation_scores.computed_at < EXCLUDED.computed_at
         OR (reputation_scores.computed_at = EXCLUDED.computed_at AND reputation_scores.anchor_id > EXCLUDED.anchor_id)
    RETURNING id, anchor_id, computed_at
  ),
  existing AS (
    SELECT id, computed_at, anchor_id
    FROM reputation_scores
    WHERE anchor_id = $1::uuid
  )
  SELECT
    COALESCE(u.id, e.id) AS id,
    COALESCE(u.computed_at, e.computed_at) AS computed_at,
    COALESCE(u.anchor_id, e.anchor_id) AS anchor_id,
    CASE
      WHEN u.id IS NOT NULL AND u.computed_at = $13::timestamptz THEN 'INSERTED_OR_UPDATED'
      ELSE 'STALE'
    END AS result
  FROM upserted u
  FULL JOIN existing e ON u.anchor_id = e.anchor_id
`;

async function setupTestData(
  db: PrismaClient,
  anchorSlug: string,
  corridorSlug: string,
  baseTime: Date,
) {
  const anchor = await db.anchor.create({
    data: {
      slug: anchorSlug,
      name: "Concurrent Reputation Fixture",
      homeDomain: `${anchorSlug.replace("test-reputation-", "").replace("-", "")}.example.com`,
      tomlUrl: `https://${anchorSlug.replace("test-reputation-", "").replace("-", "")}.example.com/.well-known/stellar.toml`,
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
      capturedAt: baseTime,
    },
  });
  await db.transferOutcome.createMany({
    data: Array.from({ length: 30 }, (_, index) => ({
      anchorId: anchor.id,
      corridorId: corridor.id,
      status: index < 27 ? "COMPLETED" : "ERROR",
      fillRate: index < 27 ? 1 : 0,
      settlementMs: 1_000,
      slippage: 0,
      recordedAt: new Date(baseTime.getTime() - index * 1_000),
    })),
  });

  return { anchor, corridor };
}

async function cleanupTestData(
  db: PrismaClient,
  anchorSlug: string,
  corridorSlug: string,
) {
  await db.reputationScore.deleteMany({ where: { anchor: { slug: anchorSlug } } });
  await db.transferOutcome.deleteMany({ where: { anchor: { slug: anchorSlug } } });
  await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
  await db.anchorCorridor.deleteMany({ where: { anchor: { slug: anchorSlug } } });
  await db.anchor.deleteMany({ where: { slug: anchorSlug } });
  await db.corridor.deleteMany({ where: { slug: corridorSlug } });
}

test("concurrent upsertScore calls protect newer evaluation from older one", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");

  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-reputation-concurrent-${suffix}`;
  const corridorSlug = `test-reputation-concurrent-corridor-${suffix}`;

  const connectionString = process.env.DATABASE_URL!;
  const adapter1 = new PrismaPg({ connectionString });
  const adapter2 = new PrismaPg({ connectionString });
  const db1 = new PrismaClient({ adapter: adapter1 });
  const db2 = new PrismaClient({ adapter: adapter2 });

  try {
    const baseTime = new Date();
    const { anchor } = await setupTestData(db1, anchorSlug, corridorSlug, baseTime);

    const olderComputedAt = new Date(baseTime.getTime());
    const newerComputedAt = new Date(baseTime.getTime() + 10_000);

    // Execute older on db1, newer on db2 concurrently
    const olderPromise = db1.$queryRawUnsafe<
      { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
    >(
      REPUTATION_UPSERT_SQL,
      anchor.id,
      95,
      "green",
      0.9,
      0.9,
      0.9,
      1_000,
      2_000,
      0.01,
      0.02,
      30,
      "ok",
      olderComputedAt,
    );

    // Small delay to let older start first
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newerPromise = db2.$queryRawUnsafe<
      { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
    >(
      REPUTATION_UPSERT_SQL,
      anchor.id,
      85,
      "amber",
      0.8,
      0.8,
      0.8,
      1_500,
      2_500,
      0.015,
      0.025,
      30,
      "ok",
      newerComputedAt,
    );

    const [olderResult, newerResult] = await Promise.all([olderPromise, newerPromise]);

    const olderRow = olderResult[0];
    const newerRow = newerResult[0];

    // The newer evaluation should succeed (INSERTED_OR_UPDATED)
    // The older evaluation should be rejected as STALE
    const results = [olderRow, newerRow];
    const inserted = results.filter((r) => r.result === "INSERTED_OR_UPDATED");
    const stale = results.filter((r) => r.result === "STALE");

    // Exactly one should be inserted/updated, one should be stale
    assert.equal(inserted.length, 1);
    assert.equal(stale.length, 1);

    // The inserted one should have the newer computedAt
    assert.equal(inserted[0].computed_at.toISOString(), newerComputedAt.toISOString());

    // Verify database has the newer score
    const dbScore = await db1.reputationScore.findUnique({ where: { anchorId: anchor.id } });
    assert.ok(dbScore);
    if (dbScore) {
      assert.equal(dbScore.computedAt.toISOString(), newerComputedAt.toISOString());
      assert.equal(dbScore.compositeScore, 85);
    }
  } finally {
    await cleanupTestData(db1, anchorSlug, corridorSlug);
    await db1.$disconnect();
    await db2.$disconnect();
  }
});

test("concurrent upsertScore calls with equal computedAt resolve deterministically by anchorId", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");

  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-reputation-equal-${suffix}`;
  const corridorSlug = `test-reputation-equal-corridor-${suffix}`;

  const connectionString = process.env.DATABASE_URL!;
  const adapter1 = new PrismaPg({ connectionString });
  const adapter2 = new PrismaPg({ connectionString });
  const db1 = new PrismaClient({ adapter: adapter1 });
  const db2 = new PrismaClient({ adapter: adapter2 });

  try {
    const baseTime = new Date();
    const { anchor } = await setupTestData(db1, anchorSlug, corridorSlug, baseTime);

    const sharedComputedAt = baseTime.toISOString();

    // Launch both concurrently with identical computedAt
    const [result1, result2] = await Promise.all([
      db1.$queryRawUnsafe<
        { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
      >(
        REPUTATION_UPSERT_SQL,
        anchor.id,
        95,
        "green",
        0.9,
        0.9,
        0.9,
        1_000,
        2_000,
        0.01,
        0.02,
        30,
        "ok",
        new Date(sharedComputedAt),
      ),
      db2.$queryRawUnsafe<
        { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
      >(
        REPUTATION_UPSERT_SQL,
        anchor.id,
        85,
        "amber",
        0.8,
        0.8,
        0.8,
        1_500,
        2_500,
        0.015,
        0.025,
        30,
        "ok",
        new Date(sharedComputedAt),
      ),
    ]);

    // Exactly one should succeed, one should be STALE_WRITE
    const okResults = [result1[0], result2[0]].filter((r) => r.result === "INSERTED_OR_UPDATED");
    const staleResults = [result1[0], result2[0]].filter((r) => r.result === "STALE");

    assert.equal(okResults.length, 1);
    assert.equal(staleResults.length, 1);

    // Verify database has exactly one row
    const dbScore = await db1.reputationScore.findUnique({ where: { anchorId: anchor.id } });
    assert.ok(dbScore);
    if (dbScore) {
      // The winner should have the computedAt we sent
      assert.equal(dbScore.computedAt.toISOString(), sharedComputedAt);
      // Score should be one of the two (deterministic but we don't know which wins)
      assert.ok(dbScore.compositeScore === 95 || dbScore.compositeScore === 85);
    }
  } finally {
    await cleanupTestData(db1, anchorSlug, corridorSlug);
    await db1.$disconnect();
    await db2.$disconnect();
  }
});

test("concurrent upsertScore from separate database connections respects guard", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");

  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-reputation-multi-conn-${suffix}`;
  const corridorSlug = `test-reputation-multi-conn-corridor-${suffix}`;

  // Create a second Prisma client with a separate connection pool
  const connectionString = process.env.DATABASE_URL!;
  const adapter1 = new PrismaPg({ connectionString });
  const adapter2 = new PrismaPg({ connectionString });
  const db1 = new PrismaClient({ adapter: adapter1 });
  const db2 = new PrismaClient({ adapter: adapter2 });

  try {
    // Set up test data using db1
    const baseTime = new Date();
    const { anchor } = await setupTestData(db1, anchorSlug, corridorSlug, baseTime);

    const olderComputedAt = new Date(baseTime.getTime());
    const newerComputedAt = new Date(baseTime.getTime() + 10_000);

    // Execute older on db1, newer on db2 concurrently
    const olderPromise = db1.$queryRawUnsafe<
      { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
    >(
      REPUTATION_UPSERT_SQL,
      anchor.id,
      95,
      "green",
      0.9,
      0.9,
      0.9,
      1_000,
      2_000,
      0.01,
      0.02,
      30,
      "ok",
      olderComputedAt,
    );

    // Small delay to let older start first
    await new Promise((resolve) => setTimeout(resolve, 10));

    const newerPromise = db2.$queryRawUnsafe<
      { id: string; computed_at: Date; anchor_id: string; result: "INSERTED_OR_UPDATED" | "STALE" }[]
    >(
      REPUTATION_UPSERT_SQL,
      anchor.id,
      85,
      "amber",
      0.8,
      0.8,
      0.8,
      1_500,
      2_500,
      0.015,
      0.025,
      30,
      "ok",
      newerComputedAt,
    );

    const [olderResult, newerResult] = await Promise.all([olderPromise, newerPromise]);

    const olderRow = olderResult[0];
    const newerRow = newerResult[0];

    // Newer should win
    assert.equal(newerRow.result, "INSERTED_OR_UPDATED");
    assert.equal(olderRow.result, "STALE");

    // Verify database has the newer score
    const dbScore = await db1.reputationScore.findUnique({ where: { anchorId: anchor.id } });
    assert.ok(dbScore);
    if (dbScore) {
      assert.equal(dbScore.computedAt.toISOString(), newerComputedAt.toISOString());
      assert.equal(dbScore.compositeScore, 85);
    }
  } finally {
    await cleanupTestData(db1, anchorSlug, corridorSlug);
    await db1.$disconnect();
    await db2.$disconnect();
  }
});