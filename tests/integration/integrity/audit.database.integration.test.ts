import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  EvidenceIntegrityAuditResult,
  EvidenceIntegrityViolationCode,
} from "@/types/integrity";

/**
 * These tests seed real corruption into a dedicated integration database and
 * must never run against production. They are gated exactly like the other
 * database integration suites in this repository.
 */
const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_INTEGRITY_DATABASE_INTEGRATION === "1";

const DAY = 24 * 60 * 60 * 1_000;

/**
 * Limits are widened only so a dirty integration database cannot push seeded
 * fixtures past the reporting cap; production always uses INTEGRITY_AUDIT_LIMITS.
 */
const INTEGRATION_LIMITS = Object.freeze({
  maxRowsPerHighVolumeTable: 50_000,
  maxFindingsPerCode: 500,
  maxFindings: 5_000,
  futureTimestampToleranceMs: 5 * 60 * 1_000,
});

type PrismaModule = typeof import("@/lib/dbClient");

type ScoreOverrides = Readonly<{
  compositeScore?: number | null;
  scoreBand?: "GREEN" | "AMBER" | "RED" | null;
  fillRate7d?: number;
  fillRate30d?: number;
  fillRate90d?: number;
  settleP50Ms?: number;
  settleP95Ms?: number;
  slippageP50?: number;
  slippageP95?: number;
  sampleSize?: number;
  state?: "OK" | "INSUFFICIENT_DATA";
  computedAt?: Date;
}>;

test("seeded corruption classes are detected and the audit never mutates rows", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { runEvidenceIntegrityAudit } = await import("@/lib/integrity/audit");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorIds: string[] = [];
  const corridorIds: string[] = [];

  const createAnchor = async (name: string) => {
    const anchor = await db.anchor.create({
      data: {
        slug: `itest-integrity-${name}-${suffix}`,
        name: `Integrity ${name}`,
        homeDomain: `${name}-${suffix}.example.com`,
        tomlUrl: `https://${name}-${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });
    anchorIds.push(anchor.id);
    return anchor.id;
  };

  const createCorridor = async (
    slug: string,
    tuple: Readonly<{
      assetCodeFrom: string;
      countryFrom: string;
      assetCodeTo: string;
      countryTo: string;
    }>,
  ) => {
    const corridor = await db.corridor.create({
      data: { slug: `${slug}-${suffix}`, ...tuple },
      select: { id: true },
    });
    corridorIds.push(corridor.id);
    return corridor.id;
  };

  try {
    const sharedAnchor = await createAnchor("shared");
    const baseCorridor = await createCorridor("base", {
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    });
    const orphanCorridor = await createCorridor("orphan", {
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "KES",
      countryTo: "KE",
    });
    await db.anchorCorridor.create({
      data: { anchorId: sharedAnchor, corridorId: baseCorridor },
    });

    // Relationship drift: evidence on a corridor with no reviewed membership.
    await db.rateSnapshot.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: orphanCorridor,
        rate: "0.2",
        sourceAmount: "1",
        destinationAmount: "0.2",
        fee: "0",
      },
    });
    await db.transferOutcome.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: orphanCorridor,
        status: "COMPLETED",
        fillRate: 1,
        settlementMs: 1_000,
        slippage: 0,
      },
    });

    // Duplicate corridor semantic identity: same tuple, different slug.
    const duplicateTuple = {
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "NGN",
      countryTo: "NG",
    } as const;
    await createCorridor("duplicate-a", duplicateTuple);
    await createCorridor("duplicate-b", duplicateTuple);

    const now = Date.now();

    // Incompatible timestamps and invalid persisted values.
    await db.rateSnapshot.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        rate: "0.175",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "0",
        capturedAt: new Date(now + DAY),
      },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        rate: "0.175",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "0",
        capturedAt: new Date(now - DAY),
      },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        rate: "0",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "0",
      },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        rate: "0.175",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "-1",
      },
    });

    await db.transferOutcome.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        status: "COMPLETED",
        fillRate: 1,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: new Date(now + DAY),
      },
    });
    await db.transferOutcome.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        status: "ERROR",
        fillRate: 1,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: new Date(now - DAY),
      },
    });
    await db.transferOutcome.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        status: "COMPLETED",
        fillRate: 2,
        settlementMs: 1_000,
        slippage: 0,
      },
    });
    await db.transferOutcome.create({
      data: {
        anchorId: sharedAnchor,
        corridorId: baseCorridor,
        status: "PARTIAL",
        fillRate: 0.5,
        settlementMs: -1,
        slippage: 0,
      },
    });

    // Invalid score/evidence combinations: one anchor per row because
    // ReputationScore has a unique anchorId.
    const validScore = {
      compositeScore: 90,
      scoreBand: "AMBER" as const,
      fillRate7d: 0.99,
      fillRate30d: 0.98,
      fillRate90d: 0.97,
      settleP50Ms: 1_000,
      settleP95Ms: 2_000,
      slippageP50: 0,
      slippageP95: 0.01,
      sampleSize: 30,
      state: "OK" as const,
    };
    const seedScore = async (name: string, data: ScoreOverrides) => {
      const anchorId = await createAnchor(name);
      await db.reputationScore.create({
        data: { anchorId, ...validScore, ...data },
      });
    };

    await seedScore("ok-thin-sample", { sampleSize: 29 });
    await seedScore("ok-no-score", { compositeScore: null });
    await seedScore("ok-no-band", { scoreBand: null });
    await seedScore("insufficient-with-score", { state: "INSUFFICIENT_DATA" as const });
    await seedScore("out-of-range", { compositeScore: 150, scoreBand: "GREEN" as const });
    await seedScore("band-mismatch", { scoreBand: "GREEN" as const });
    await seedScore("negative-sample", {
      state: "INSUFFICIENT_DATA" as const,
      compositeScore: null,
      scoreBand: null,
      sampleSize: -1,
    });
    await seedScore("bad-fill-rate", { fillRate7d: 2 });
    await seedScore("percentile-order", { settleP50Ms: 5_000, settleP95Ms: 1_000 });
    await seedScore("negative-duration", { settleP50Ms: -1, settleP95Ms: 1_000 });
    await seedScore("future-score", { computedAt: new Date(now + DAY) });
    await seedScore("stale-score", { computedAt: new Date(now - DAY) });

    const before = await tableCounts(db);
    const result: EvidenceIntegrityAuditResult = await runEvidenceIntegrityAudit({
      limits: INTEGRATION_LIMITS,
    });
    const after = await tableCounts(db);

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.deepEqual(after, before, "the read-only audit must not mutate rows");

    const seededIds = new Set([...anchorIds, ...corridorIds]);
    const seededFindings = result.findings.filter((finding) =>
      seededIds.has(finding.entity.id));
    const detected = new Set(seededFindings.map((finding) => finding.code));

    const expected: readonly EvidenceIntegrityViolationCode[] = [
      "RATE_SNAPSHOT_MEMBERSHIP_MISSING",
      "TRANSFER_OUTCOME_MEMBERSHIP_MISSING",
      "DUPLICATE_CORRIDOR_SEMANTIC_IDENTITY",
      "RATE_SNAPSHOT_TIMESTAMP_FUTURE",
      "RATE_SNAPSHOT_TIMESTAMP_BEFORE_ANCHOR",
      "TRANSFER_OUTCOME_TIMESTAMP_FUTURE",
      "TRANSFER_OUTCOME_TIMESTAMP_BEFORE_ANCHOR",
      "REPUTATION_SCORE_TIMESTAMP_FUTURE",
      "REPUTATION_SCORE_TIMESTAMP_BEFORE_ANCHOR",
      "REPUTATION_STATE_OK_WITH_INSUFFICIENT_SAMPLE",
      "REPUTATION_STATE_OK_WITHOUT_COMPOSITE_SCORE",
      "REPUTATION_STATE_OK_WITHOUT_SCORE_BAND",
      "REPUTATION_INSUFFICIENT_DATA_WITH_SCORE",
      "REPUTATION_COMPOSITE_SCORE_OUT_OF_RANGE",
      "REPUTATION_SCORE_BAND_MISMATCH",
      "REPUTATION_SAMPLE_SIZE_NEGATIVE",
      "REPUTATION_FILL_RATE_OUT_OF_RANGE",
      "REPUTATION_PERCENTILE_ORDER",
      "REPUTATION_DURATION_NEGATIVE",
      "RATE_SNAPSHOT_NON_POSITIVE_AMOUNT",
      "RATE_SNAPSHOT_NEGATIVE_FEE",
      "TRANSFER_OUTCOME_NEGATIVE_SETTLEMENT",
      "TRANSFER_OUTCOME_FILL_RATE_OUT_OF_RANGE",
    ];
    for (const code of expected) {
      assert.equal(
        detected.has(code),
        true,
        `expected seeded ${code}; detected ${[...detected].sort().join(", ")}`,
      );
    }
    assert.equal(
      detected.has("TRANSFER_OUTCOME_INVALID_METRIC"),
      false,
      "non-finite metrics cannot be persisted through the Prisma write boundary",
    );
  } finally {
    await db.reputationScore.deleteMany({ where: { anchorId: { in: anchorIds } } });
    await db.transferOutcome.deleteMany({ where: { anchorId: { in: anchorIds } } });
    await db.rateSnapshot.deleteMany({ where: { anchorId: { in: anchorIds } } });
    await db.anchorCorridor.deleteMany({
      where: {
        OR: [
          { anchorId: { in: anchorIds } },
          { corridorId: { in: corridorIds } },
        ],
      },
    });
    await db.anchor.deleteMany({ where: { id: { in: anchorIds } } });
    await db.corridor.deleteMany({ where: { id: { in: corridorIds } } });
    await db.$disconnect();
  }
});

test("a coherent persisted graph audits with zero findings", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { runEvidenceIntegrityAudit } = await import("@/lib/integrity/audit");
  const suffix = randomUUID().replaceAll("-", "");

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: `itest-integrity-clean-${suffix}`,
        name: "Integrity Clean",
        homeDomain: `clean-${suffix}.example.com`,
        tomlUrl: `https://clean-${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });
    const corridor = await db.corridor.create({
      data: {
        slug: `itest-integrity-clean-${suffix}`,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
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
        rate: "0.175",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "0.5",
      },
    });
    await db.transferOutcome.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridor.id,
        status: "COMPLETED",
        fillRate: 1,
        settlementMs: 1_200,
        slippage: 0,
      },
    });
    await db.reputationScore.create({
      data: {
        anchorId: anchor.id,
        compositeScore: 90,
        scoreBand: "AMBER",
        fillRate7d: 0.99,
        fillRate30d: 0.98,
        fillRate90d: 0.97,
        settleP50Ms: 1_000,
        settleP95Ms: 2_000,
        slippageP50: 0,
        slippageP95: 0.01,
        sampleSize: 30,
        state: "OK",
      },
    });

    const result = await runEvidenceIntegrityAudit({ limits: INTEGRATION_LIMITS });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const fixtureFindings = result.findings.filter((finding) =>
      finding.entity.id === anchor.id || finding.entity.id === corridor.id);
    assert.deepEqual([...fixtureFindings], []);
  } finally {
    await db.reputationScore.deleteMany({ where: { anchor: { slug: `itest-integrity-clean-${suffix}` } } });
    await db.transferOutcome.deleteMany({ where: { anchor: { slug: `itest-integrity-clean-${suffix}` } } });
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: `itest-integrity-clean-${suffix}` } } });
    await db.anchorCorridor.deleteMany({ where: { anchor: { slug: `itest-integrity-clean-${suffix}` } } });
    await db.anchor.deleteMany({ where: { slug: `itest-integrity-clean-${suffix}` } });
    await db.corridor.deleteMany({ where: { slug: `itest-integrity-clean-${suffix}` } });
    await db.$disconnect();
  }
});

async function tableCounts(
  db: PrismaModule["db"],
): Promise<Readonly<Record<string, number>>> {
  const [anchors, corridors, anchorCorridors, rateSnapshots, transferOutcomes, reputationScores] =
    await Promise.all([
      db.anchor.count(),
      db.corridor.count(),
      db.anchorCorridor.count(),
      db.rateSnapshot.count(),
      db.transferOutcome.count(),
      db.reputationScore.count(),
    ]);
  return Object.freeze({
    anchors,
    corridors,
    anchorCorridors,
    rateSnapshots,
    transferOutcomes,
    reputationScores,
  });
}
