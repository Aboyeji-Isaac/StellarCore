import { Prisma } from "@/app/generated/prisma/client";
import {
  readInReputationSnapshot,
  type ReputationSnapshotFailure,
} from "@/lib/reputation/snapshot";
import type {
  PersistedReputationScore,
  ReputationEvidence,
  ReputationEvidenceReadFailure,
  ReputationPersistenceInput,
  ReputationRepository,
} from "@/types/reputation";

type LatestRateRow = Readonly<{ corridorSlug: string; capturedAt: Date }>;

/**
 * The newest snapshot time per corridor for one anchor, as a bounded set of
 * index probes instead of a walk over the anchor's history.
 *
 * Exported so differential tests and the benchmark run the exact SQL that
 * production uses.
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
    const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
    await ensureDatabaseEnvironment();

    const snapshotResult = await readInReputationSnapshot(db, (tx, identity) =>
      readEvidenceInSnapshot(tx, identity, anchorSlug, outcomeWindowStart),
    );

    if (!snapshotResult.ok) return toEvidenceReadFailure(snapshotResult.failure);
    return snapshotResult.value;
  },

  async upsertScore(input: ReputationPersistenceInput): Promise<PersistedReputationScore> {
    const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");
    await ensureDatabaseEnvironment();

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

    const rows = await db.$queryRaw<Array<{ id: string; computedAt: Date; written: boolean }>>(Prisma.sql`
      WITH written AS (
        INSERT INTO reputation_scores (
          anchor_id, composite_score, score_band, fill_rate_7d, fill_rate_30d,
          fill_rate_90d, settle_p50_ms, settle_p95_ms, slippage_p50, slippage_p95,
          sample_size, state, computed_at
        ) VALUES (
          ${input.anchorId}::uuid, ${data.compositeScore}, ${calculation.scoreBand?.toLowerCase() ?? null}::reputation_score_band,
          ${data.fillRate7d}, ${data.fillRate30d}, ${data.fillRate90d},
          ${data.settleP50Ms}, ${data.settleP95Ms}, ${data.slippageP50}, ${data.slippageP95},
          ${data.sampleSize}, ${calculation.state === "established" ? "ok" : "insufficient_data"}::reputation_state,
          ${data.computedAt}
        )
        ON CONFLICT (anchor_id) DO UPDATE SET
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
        RETURNING id, computed_at AS "computedAt", true AS written
      )
      SELECT id, "computedAt", written FROM written
      UNION ALL
      SELECT id, computed_at AS "computedAt", false AS written
      FROM reputation_scores
      WHERE anchor_id = ${input.anchorId}::uuid
        AND NOT EXISTS (SELECT 1 FROM written)
    `);
    const persisted = rows[0];
    if (!persisted) throw new Error("Reputation score write returned no current row");

    return Object.freeze({
      id: persisted.id,
      anchorSlug: calculation.anchorSlug,
      computedAt: new Date(persisted.computedAt.getTime()),
      writeStatus: persisted.written
        ? "written"
        : persisted.computedAt.getTime() === data.computedAt.getTime()
          ? "rejected_tie"
          : "rejected_stale",
    });
  },
});

async function readEvidenceInSnapshot(
  tx: Prisma.TransactionClient,
  identity: Readonly<{ snapshotId: string; readAt: Date }>,
  anchorSlug: string,
  outcomeWindowStart: Date,
): Promise<ReputationEvidence | null> {
  const anchor = await tx.anchor.findUnique({
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
    tx.$queryRaw<LatestRateRow[]>(latestCorridorRatesQuery(anchor.id)),
    tx.transferOutcome.findMany({
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
    corridorSlugs: Object.freeze(
      anchor.corridors
        .map(({ corridor }) => corridor.slug)
        .sort((left, right) => left.localeCompare(right)),
    ),
    latestRates: Object.freeze(
      latestRates.map((rate) =>
        Object.freeze({
          corridorSlug: rate.corridorSlug,
          capturedAt: new Date(rate.capturedAt.getTime()),
        }),
      ),
    ),
    transferOutcomes: Object.freeze(
      transferOutcomes.map((outcome) =>
        Object.freeze({
          status: outcome.status,
          settlementMs: outcome.settlementMs,
          slippage: outcome.slippage,
          recordedAt: new Date(outcome.recordedAt.getTime()),
        }),
      ),
    ),
    snapshot: Object.freeze({
      snapshotId: identity.snapshotId,
      readAt: new Date(identity.readAt.getTime()),
      isolationLevel: "REPEATABLE READ",
    }),
  });
}

function toEvidenceReadFailure(
  failure: ReputationSnapshotFailure,
): ReputationEvidenceReadFailure {
  return Object.freeze({
    code: failure.code,
    retryable: failure.retryable,
    attempts: failure.attempts,
  });
}
