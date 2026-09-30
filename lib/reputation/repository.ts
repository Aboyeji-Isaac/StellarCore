import { Prisma } from "@/app/generated/prisma/client";
import type {
  PersistedReputationScore,
  ReputationEvidence,
  ReputationPersistenceInput,
  ReputationRepository,
} from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;

/**
 * The newest snapshot time per corridor for one anchor, as a bounded set of
 * index probes instead of a walk over the anchor's history.
 *
 * Where the group set comes from: `corridors`, one row per corridor and
 * independent of how many snapshots exist. `rate_snapshots.corridor_id` is a
 * foreign key, so every corridor this anchor has ever quoted is in that table,
 * including one it is no longer a member of. Nothing is filtered on membership
 * or age, so stale and historically associated corridors stay visible.
 *
 * For each corridor the lateral subquery takes the single newest row for
 * (anchor, corridor) in `captured_at DESC, id DESC` order, the tie-break the
 * previous DISTINCT ON used, from rate_snapshots_anchor_corridor_latest_idx. A
 * corridor the anchor never quoted yields no row, as before. Slugs are unique,
 * so ordering by slug is the order DISTINCT ON (corridor.slug) produced.
 *
 * Exported so the differential tests and the benchmark run the exact text that
 * production runs.
 */
export function latestCorridorRatesQuery(anchorId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT
      corridor.slug AS "corridorSlug",
      latest.captured_at AS "capturedAt"
    FROM corridors AS corridor
    CROSS JOIN LATERAL (
      SELECT snapshot.captured_at
      FROM rate_snapshots AS snapshot
      WHERE snapshot.anchor_id = ${anchorId}::uuid
        AND snapshot.corridor_id = corridor.id
      ORDER BY snapshot.captured_at DESC, snapshot.id DESC
      LIMIT 1
    ) AS latest
    ORDER BY corridor.slug
  `;
}

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
      db.$queryRaw<LatestRateRow[]>(latestCorridorRatesQuery(anchor.id)),
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
