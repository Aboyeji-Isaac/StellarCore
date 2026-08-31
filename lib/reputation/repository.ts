import { Prisma } from "@/app/generated/prisma/client";
import type {
  PersistedReputationScore,
  ReputationEvidence,
  ReputationPersistenceInput,
  ReputationRepository,
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
    const data = {
      compositeScore: calculation.score,
      scoreBand: calculation.scoreBand,
      fillRate7d: calculation.metrics.fillRate7d,
      fillRate30d: calculation.metrics.fillRate30d,
      fillRate90d: calculation.metrics.fillRate90d,
      settleP50Ms: calculation.metrics.settleP50Ms,
      settleP95Ms: calculation.metrics.settleP95Ms,
      slippageP50: calculation.metrics.slippageP50,
      slippageP95: calculation.metrics.slippageP95,
      sampleSize: calculation.evidence.outcomeCount,
      state: calculation.state === "established" ? "OK" : "INSUFFICIENT_DATA",
      computedAt: new Date(calculation.computedAt),
    } as const;
    const persisted = await db.reputationScore.upsert({
      where: { anchorId: input.anchorId },
      create: { anchorId: input.anchorId, ...data },
      update: data,
      select: { id: true, computedAt: true, anchor: { select: { slug: true } } },
    });

    return Object.freeze({
      id: persisted.id,
      anchorSlug: persisted.anchor.slug,
      computedAt: new Date(persisted.computedAt.getTime()),
    });
  },
});
