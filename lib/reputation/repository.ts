import { Prisma } from "@/app/generated/prisma/client";
import type {
  ReputationEvidence,
  ReputationPersistenceInput,
  ReputationRepository,
  ReputationUpsertResult,
} from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;

// Ordering rule: (computedAt ASC, anchorId ASC) - lexicographic tie-breaker
// Only replace if incoming is strictly newer per this ordering.
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
    CASE WHEN u.id IS NOT NULL THEN 'INSERTED_OR_UPDATED' ELSE 'STALE' END AS result
  FROM upserted u
  FULL JOIN existing e ON u.anchor_id = e.anchor_id
`;

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

  async upsertScore(input: ReputationPersistenceInput): Promise<ReputationUpsertResult> {
    const { db } = await import("@/lib/dbClient");
    const { calculation } = input;
    const computedAt = new Date(calculation.computedAt);

    const data = {
      compositeScore: calculation.score,
      scoreBand: calculation.scoreBand?.toLowerCase() ?? null,
      fillRate7d: calculation.metrics.fillRate7d,
      fillRate30d: calculation.metrics.fillRate30d,
      fillRate90d: calculation.metrics.fillRate90d,
      settleP50Ms: calculation.metrics.settleP50Ms,
      settleP95Ms: calculation.metrics.settleP95Ms,
      slippageP50: calculation.metrics.slippageP50,
      slippageP95: calculation.metrics.slippageP95,
      sampleSize: calculation.evidence.outcomeCount,
      state: calculation.state === "established" ? "ok" : "insufficient_data",
      computedAt,
    } as const;

    const result = await db.$queryRawUnsafe<{
      id: string;
      computed_at: Date;
      anchor_id: string;
      result: "INSERTED_OR_UPDATED" | "STALE";
    }[]>(
      REPUTATION_UPSERT_SQL,
      input.anchorId,
      data.compositeScore,
      data.scoreBand,
      data.fillRate7d,
      data.fillRate30d,
      data.fillRate90d,
      data.settleP50Ms,
      data.settleP95Ms,
      data.slippageP50,
      data.slippageP95,
      data.sampleSize,
      data.state,
      data.computedAt,
    );

    const row = result[0];
    if (!row) {
      // Should not happen, but guard anyway
      throw new Error("Reputation upsert returned no row");
    }

    if (row.result === "STALE") {
      return Object.freeze({
        ok: false,
        code: "STALE_WRITE",
        existingComputedAt: new Date(row.computed_at.getTime()),
      });
    }

    // Fetch the anchor slug for the returned row
    const anchor = await db.anchor.findUnique({
      where: { id: row.anchor_id },
      select: { slug: true },
    });

    return Object.freeze({
      ok: true,
      score: Object.freeze({
        id: row.id,
        anchorSlug: anchor?.slug ?? "",
        computedAt: new Date(row.computed_at.getTime()),
      }),
    });
  },
});