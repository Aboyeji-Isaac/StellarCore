import { Prisma } from "@/app/generated/prisma/client";
import {
  MAX_REPORTED_INTEGRITY_ISSUES,
  reportEvidenceIntegrityIssues,
} from "@/lib/evidence/integrity";
import {
  RATE_SNAPSHOT_CORRUPTION_CLASS,
  toSnapshotIssue,
  VALID_RATE_SNAPSHOT,
  type CorruptSnapshotRow,
} from "@/lib/evidence/rateSnapshotValidity";
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
}>;

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
    const rows = await db.$queryRaw<PrismaLatestRateRow[]>(Prisma.sql`
      SELECT DISTINCT ON (snapshot.anchor_id)
        snapshot.id,
        anchor.slug AS "anchorSlug",
        anchor.name AS "anchorName",
        snapshot.rate,
        snapshot.source_amount AS "sourceAmount",
        snapshot.destination_amount AS "destinationAmount",
        snapshot.fee,
        snapshot.captured_at AS "capturedAt"
      FROM rate_snapshots AS snapshot
      INNER JOIN anchors AS anchor ON anchor.id = snapshot.anchor_id
      WHERE snapshot.corridor_id = ${corridorId}::uuid
        AND ${VALID_RATE_SNAPSHOT}
      ORDER BY snapshot.anchor_id, snapshot.captured_at DESC, snapshot.id DESC
    `);

    // Corrupt snapshots are excluded above so they cannot shadow valid history;
    // they are reported by stable identifier only.
    const corrupt = await db.$queryRaw<CorruptSnapshotRow[]>(Prisma.sql`
      SELECT
        snapshot.id::text AS id,
        ${RATE_SNAPSHOT_CORRUPTION_CLASS} AS class,
        anchor.slug AS "anchorSlug",
        corridor.slug AS "corridorSlug",
        count(*) OVER () AS total
      FROM rate_snapshots AS snapshot
      INNER JOIN anchors AS anchor ON anchor.id = snapshot.anchor_id
      INNER JOIN corridors AS corridor ON corridor.id = snapshot.corridor_id
      WHERE snapshot.corridor_id = ${corridorId}::uuid
        AND NOT ${VALID_RATE_SNAPSHOT}
      ORDER BY snapshot.id
      LIMIT ${MAX_REPORTED_INTEGRITY_ISSUES}
    `);
    if (corrupt.length > 0) {
      reportEvidenceIntegrityIssues(corrupt.map(toSnapshotIssue), Number(corrupt[0]!.total));
    }

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
  });
}
