import { Prisma } from "@/app/generated/prisma/client";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";

type PrismaLatestRateRow = Readonly<{
  id: string;
  anchorSlug: string;
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
      select: { id: true, slug: true },
    });
  },

  async findLatestObservations(corridorId) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<PrismaLatestRateRow[]>(Prisma.sql`
      SELECT DISTINCT ON (snapshot.anchor_id)
        snapshot.id,
        anchor.slug AS "anchorSlug",
        snapshot.rate,
        snapshot.source_amount AS "sourceAmount",
        snapshot.destination_amount AS "destinationAmount",
        snapshot.fee,
        snapshot.captured_at AS "capturedAt"
      FROM rate_snapshots AS snapshot
      INNER JOIN anchors AS anchor ON anchor.id = snapshot.anchor_id
      WHERE snapshot.corridor_id = ${corridorId}::uuid
      ORDER BY snapshot.anchor_id, snapshot.captured_at DESC, snapshot.id DESC
    `);

    return Object.freeze(rows.map(toRepositoryObservation));
  },
});

function toRepositoryObservation(
  row: PrismaLatestRateRow,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id: row.id,
    anchorSlug: row.anchorSlug,
    rate: row.rate.toString(),
    sourceAmount: row.sourceAmount.toString(),
    destinationAmount: row.destinationAmount.toString(),
    fee: row.fee.toString(),
    capturedAt: new Date(row.capturedAt.getTime()),
  });
}
