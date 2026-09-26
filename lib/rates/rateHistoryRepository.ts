import { Prisma } from "@/app/generated/prisma/client";
import type {
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";

type PrismaRateHistoryRow = Readonly<{
  id: string;
  anchorSlug: string;
  anchorName: string;
  rate: Prisma.Decimal;
  sourceAmount: Prisma.Decimal;
  destinationAmount: Prisma.Decimal;
  fee: Prisma.Decimal;
  capturedAt: Date;
}>;

export const PRISMA_RATE_HISTORY_REPOSITORY: RateHistoryRepository = Object.freeze({
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

  async findHistoryObservations(corridorId, fromDate, toDate) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<PrismaRateHistoryRow[]>(Prisma.sql`
      SELECT
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
        AND snapshot.captured_at >= ${fromDate}
        AND snapshot.captured_at <= ${toDate}
      ORDER BY snapshot.captured_at ASC, snapshot.id ASC
    `);

    return Object.freeze(rows.map(toRepositoryObservation));
  },
});

function toRepositoryObservation(
  row: PrismaRateHistoryRow,
): RateHistoryRepositoryObservation {
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
