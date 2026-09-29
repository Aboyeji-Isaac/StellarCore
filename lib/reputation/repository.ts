import { Prisma } from "@/app/generated/prisma/client";
import { REPUTATION_POLICY_VERSION } from "@/constants/reputation";
import type {
  PersistedReputationScore,
  ReputationEvidence,
  ReputationPersistenceInput,
  ReputationRepository,
  ReputationHistoryRecord,
} from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;

export const PRISMA_REPUTATION_REPOSITORY: ReputationRepository = Object.freeze({
  async readEvidence(anchorSlug, outcomeWindowStart) {
    const { db } = await import("@/lib/dbClient");
    const anchor = await db.anchor.findUnique({
      where: { slug: anchorSlug },
      select: {
        id: true,
        slug: true,
        status: true,
        corridors: { select: { corridor: { select: { slug: true } } } },
      },
    });
    if (!anchor) return null;

    const [latestRates, transferOutcomes] = await Promise.all([
      db.$queryRaw<LatestRateRow[]>(Prisma.sql`
        SELECT DISTINCT ON (corridor.slug)
          corridor.slug AS "corridorSlug",
          snapshot.captured_at AS "capturedAt"
        FROM rate_snapshots AS snapshot
        INNER JOIN corridors AS corridor ON corridor.id = snapshot.corridor_id
        WHERE snapshot.anchor_id = ${anchor.id}::uuid
        ORDER BY corridor.slug, snapshot.captured_at DESC, snapshot.id DESC
      `),
      db.transferOutcome.findMany({
        where: { anchorId: anchor.id, recordedAt: { gte: outcomeWindowStart } },
        orderBy: [{ recordedAt: "asc" }, { id: "asc" }],
        select: {
          status: true,
          settlementMs: true,
          slippage: true,
          recordedAt: true,
        },
      }),
    ]);

    return Object.freeze({
      anchorId: anchor.id,
      anchorSlug: anchor.slug,
      status: anchor.status,
      corridorSlugs: Object.freeze(anchor.corridors
        .map(({ corridor }) => corridor.slug)
        .sort((left, right) => left.localeCompare(right))),
      latestRates: Object.freeze(latestRates.map((rate) => Object.freeze({
        corridorSlug: rate.corridorSlug,
        capturedAt: new Date(rate.capturedAt.getTime()),
      }))),
      transferOutcomes: Object.freeze(transferOutcomes.map((outcome) =>
        Object.freeze({
          status: outcome.status,
          settlementMs: outcome.settlementMs,
          slippage: outcome.slippage,
          recordedAt: new Date(outcome.recordedAt.getTime()),
        }))),
    }) satisfies ReputationEvidence;
  },

  async upsertScore(input: ReputationPersistenceInput): Promise<PersistedReputationScore> {
    const { db } = await import("@/lib/dbClient");
    const { calculation } = input;
    const state = calculation.state === "established" ? "OK" : "INSUFFICIENT_DATA";
    const evaluationData = {
      anchorId: input.anchorId,
      algorithmVersion: REPUTATION_POLICY_VERSION,
      state,
      compositeScore: calculation.score,
      scoreBand: calculation.scoreBand,
      availabilityWeight: calculation.components.availability.weight,
      availabilityScore: calculation.components.availability.score,
      availabilityEarnedPoints: calculation.components.availability.earnedPoints,
      rateFreshnessWeight: calculation.components.rateFreshness.weight,
      rateFreshnessScore: calculation.components.rateFreshness.score,
      rateFreshnessEarnedPoints: calculation.components.rateFreshness.earnedPoints,
      coverageWeight: calculation.components.coverage.weight,
      coverageScore: calculation.components.coverage.score,
      coverageEarnedPoints: calculation.components.coverage.earnedPoints,
      transferReliabilityWeight: calculation.components.transferReliability.weight,
      transferReliabilityScore: calculation.components.transferReliability.score,
      transferReliabilityEarnedPoints: calculation.components.transferReliability.earnedPoints,
      corridorCount: calculation.evidence.corridorCount,
      latestRateCount: calculation.evidence.latestRateCount,
      freshRateCount: calculation.evidence.freshRateCount,
      outcomeCount: calculation.evidence.outcomeCount,
      completedOutcomeCount: calculation.evidence.completedOutcomeCount,
      minimumOutcomeCount: calculation.evidence.minimumOutcomeCount,
      fillRate7d: calculation.metrics.fillRate7d,
      fillRate30d: calculation.metrics.fillRate30d,
      fillRate90d: calculation.metrics.fillRate90d,
      settleP50Ms: calculation.metrics.settleP50Ms,
      settleP95Ms: calculation.metrics.settleP95Ms,
      slippageP50: calculation.metrics.slippageP50,
      slippageP95: calculation.metrics.slippageP95,
      computedAt: new Date(calculation.computedAt),
    } as const;
    const persisted = await db.$transaction(async (transaction) => {
      // Serialize evaluations per anchor so concurrent transactions cannot let
      // an older computation overwrite a newer current projection.
      await transaction.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${input.anchorId}::text, 0))
      `);
      const evaluation = await transaction.reputationEvaluation.create({
        data: evaluationData,
        select: { id: true },
      });
      const latest = await transaction.reputationEvaluation.findFirstOrThrow({
        where: { anchorId: input.anchorId },
        orderBy: [{ computedAt: "desc" }, { id: "desc" }],
      });
      const projection = {
        evaluationId: latest.id,
        compositeScore: latest.compositeScore,
        scoreBand: latest.scoreBand,
        fillRate7d: latest.fillRate7d,
        fillRate30d: latest.fillRate30d,
        fillRate90d: latest.fillRate90d,
        settleP50Ms: latest.settleP50Ms,
        settleP95Ms: latest.settleP95Ms,
        slippageP50: latest.slippageP50,
        slippageP95: latest.slippageP95,
        sampleSize: latest.outcomeCount ?? 0,
        state: latest.state,
        computedAt: latest.computedAt,
      } as const;
      const score = await transaction.reputationScore.upsert({
        where: { anchorId: input.anchorId },
        create: { anchorId: input.anchorId, ...projection },
        update: projection,
        select: { id: true, computedAt: true, anchor: { select: { slug: true } } },
      });
      return { ...score, evaluationId: evaluation.id };
    });

    return Object.freeze({
      id: persisted.id,
      evaluationId: persisted.evaluationId,
      anchorSlug: persisted.anchor.slug,
      computedAt: new Date(persisted.computedAt.getTime()),
    });
  },
});

export async function listReputationHistory(
  anchorSlug: string,
  limit = 100,
): Promise<readonly ReputationHistoryRecord[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("History limit must be between 1 and 100");
  }
  const { db } = await import("@/lib/dbClient");
  const rows = await db.reputationEvaluation.findMany({
    where: { anchor: { slug: anchorSlug } },
    orderBy: [{ computedAt: "desc" }, { id: "desc" }],
    take: limit,
    select: {
      id: true,
      algorithmVersion: true,
      isLegacy: true,
      computedAt: true,
      state: true,
      compositeScore: true,
      scoreBand: true,
      availabilityWeight: true,
      availabilityScore: true,
      availabilityEarnedPoints: true,
      rateFreshnessWeight: true,
      rateFreshnessScore: true,
      rateFreshnessEarnedPoints: true,
      coverageWeight: true,
      coverageScore: true,
      coverageEarnedPoints: true,
      transferReliabilityWeight: true,
      transferReliabilityScore: true,
      transferReliabilityEarnedPoints: true,
      corridorCount: true,
      latestRateCount: true,
      freshRateCount: true,
      outcomeCount: true,
      completedOutcomeCount: true,
      minimumOutcomeCount: true,
      fillRate7d: true,
      fillRate30d: true,
      fillRate90d: true,
      settleP50Ms: true,
      settleP95Ms: true,
      slippageP50: true,
      slippageP95: true,
      anchor: { select: { slug: true } },
    },
  });
  return Object.freeze(rows.map((row) => Object.freeze({
    id: row.id,
    anchorSlug: row.anchor.slug,
    algorithmVersion: row.algorithmVersion,
    isLegacy: row.isLegacy,
    computedAt: new Date(row.computedAt.getTime()),
    state: row.state,
    compositeScore: row.compositeScore,
    scoreBand: row.scoreBand,
    components: Object.freeze({
      availability: historyComponent(row.availabilityWeight, row.availabilityScore, row.availabilityEarnedPoints),
      rateFreshness: historyComponent(row.rateFreshnessWeight, row.rateFreshnessScore, row.rateFreshnessEarnedPoints),
      coverage: historyComponent(row.coverageWeight, row.coverageScore, row.coverageEarnedPoints),
      transferReliability: historyComponent(row.transferReliabilityWeight, row.transferReliabilityScore, row.transferReliabilityEarnedPoints),
    }),
    evidence: Object.freeze({
      corridorCount: row.corridorCount,
      latestRateCount: row.latestRateCount,
      freshRateCount: row.freshRateCount,
      outcomeCount: row.outcomeCount,
      completedOutcomeCount: row.completedOutcomeCount,
      minimumOutcomeCount: row.minimumOutcomeCount,
    }),
    metrics: Object.freeze({
      fillRate7d: row.fillRate7d,
      fillRate30d: row.fillRate30d,
      fillRate90d: row.fillRate90d,
      settleP50Ms: row.settleP50Ms,
      settleP95Ms: row.settleP95Ms,
      slippageP50: row.slippageP50,
      slippageP95: row.slippageP95,
    }),
  })));
}

function historyComponent(weight: number | null, score: number | null, earnedPoints: number | null) {
  return Object.freeze({ weight, score, earnedPoints });
}
