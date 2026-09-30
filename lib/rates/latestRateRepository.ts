import { Prisma } from "@/app/generated/prisma/client";
import type { RateAnomalyReason, RateAnomalyStatus } from "@/types/rates";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";

type PrismaLatestRateRow = Readonly<{
  id: string;
  anchorSlug: string;
  anchorName: string;
  rate: Prisma.Decimal;
  sourceAmount: Prisma.Decimal;
  destinationAmount: Prisma.Decimal;
  fee: Prisma.Decimal;
  capturedAt: Date;
  anomalyStatus: RateAnomalyStatus | null;
  anomalyReason: string | null;
}>;

/**
 * The newest snapshot per anchor for one corridor, as a bounded set of index
 * probes instead of a walk over the corridor's history.
 *
 * Where the group set comes from: `anchors`, one row per anchor and independent
 * of how many snapshots exist. `rate_snapshots.anchor_id` is a foreign key, so
 * every anchor that has ever quoted this corridor is in that table, including
 * one whose `anchor_corridors` membership has since been removed. Nothing is
 * filtered on membership, status, or age here, which is what keeps stale and
 * historically associated observations visible exactly as before.
 *
 * For each anchor the lateral subquery takes the single newest row for
 * (corridor, anchor) in `captured_at DESC, id DESC` order, the same tie-break
 * the previous DISTINCT ON used, from rate_snapshots_latest_observation_idx.
 * An anchor with no snapshot in this corridor yields no row, as before. The
 * result stays ordered by anchor id, which is what DISTINCT ON produced.
 *
 * With `withAnomalyAssessment` (issue #186), the outer select additionally
 * carries the newest persisted cross-source anomaly verdict for each selected
 * snapshot: one extra bounded index probe per selected row, never a scan of
 * assessment history, and no change to the latest-per-anchor selection itself.
 * Rows without any assessment (or a null status mapping) surface as
 * `anomaly: null` so the read model can evaluate the identical criterion.
 *
 * Exported so the differential tests and the benchmark run the exact text that
 * production runs.
 */
export function latestObservationsQuery(
  corridorId: string,
  options: Readonly<{ withAnomalyAssessment?: boolean }> = {},
): Prisma.Sql {
  const anomalyColumns = options.withAnomalyAssessment
    ? Prisma.sql`,
      assessment.status::text AS "anomalyStatus",
      assessment.reason AS "anomalyReason"`
    : Prisma.empty;
  const anomalyJoin = options.withAnomalyAssessment
    ? Prisma.sql`
    LEFT JOIN LATERAL (
      SELECT candidate.status, candidate.reason
      FROM rate_anomaly_assessments AS candidate
      WHERE candidate.snapshot_id = latest.id
      ORDER BY candidate.assessed_at DESC, candidate.id DESC
      LIMIT 1
    ) AS assessment ON TRUE`
    : Prisma.empty;
  return Prisma.sql`
    SELECT
      latest.id,
      anchor.slug AS "anchorSlug",
      anchor.name AS "anchorName",
      latest.rate,
      latest.source_amount AS "sourceAmount",
      latest.destination_amount AS "destinationAmount",
      latest.fee,
      latest.captured_at AS "capturedAt"${anomalyColumns}
    FROM anchors AS anchor
    CROSS JOIN LATERAL (
      SELECT
        snapshot.id,
        snapshot.rate,
        snapshot.source_amount,
        snapshot.destination_amount,
        snapshot.fee,
        snapshot.captured_at
      FROM rate_snapshots AS snapshot
      WHERE snapshot.corridor_id = ${corridorId}::uuid
        AND snapshot.anchor_id = anchor.id
      ORDER BY snapshot.captured_at DESC, snapshot.id DESC
      LIMIT 1
    ) AS latest${anomalyJoin}
    ORDER BY anchor.id
  `;
}

export const PRISMA_LATEST_RATE_REPOSITORY: LatestRateRepository = Object.freeze({
  async findCorridorBySlug(slug) {
    const { db } = await import("@/lib/dbClient");
    return db.corridor.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        assetCodeFrom: true,
        countryFrom: true,
        assetCodeTo: true,
        countryTo: true,
      },
    });
  },

  async findLatestObservations(corridorId) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<PrismaLatestRateRow[]>(
      latestObservationsQuery(corridorId, { withAnomalyAssessment: true }),
    );

    return Object.freeze(rows.map(toRepositoryObservation));
  },
});

function toRepositoryObservation(
  row: PrismaLatestRateRow,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id: row.id,
    anchorSlug: row.anchorSlug,
    anchorName: row.anchorName,
    rate: row.rate.toString(),
    sourceAmount: row.sourceAmount.toString(),
    destinationAmount: row.destinationAmount.toString(),
    fee: row.fee.toString(),
    capturedAt: new Date(row.capturedAt.getTime()),
    anomaly: row.anomalyStatus === null
      ? null
      : Object.freeze({
        status: row.anomalyStatus,
        reason: row.anomalyReason as RateAnomalyReason | null,
      }),
  });
}
