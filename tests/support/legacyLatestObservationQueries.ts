import { Prisma } from "@/app/generated/prisma/client";
import { PRISMA_LATEST_RATE_REPOSITORY } from "@/lib/rates/latestRateRepository";
import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type { ReputationRepository } from "@/types/reputation";

/**
 * The latest-observation queries as they were before the lateral rewrite
 * (audited main 973cf28), frozen verbatim.
 *
 * They exist only as the reference the differential tests and the benchmark
 * compare the production queries against. Nothing in `lib/` may import this.
 * Do not "improve" them: their value is that they are the old behaviour.
 */

/** DISTINCT ON (anchor_id) across the corridor's whole history. */
export function legacyLatestObservationsQuery(corridorId: string): Prisma.Sql {
  return Prisma.sql`
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
    ORDER BY snapshot.anchor_id, snapshot.captured_at DESC, snapshot.id DESC
  `;
}

/** DISTINCT ON (corridor.slug) across the anchor's whole history. */
export function legacyLatestCorridorRatesQuery(anchorId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT DISTINCT ON (corridor.slug)
      corridor.slug AS "corridorSlug",
      snapshot.captured_at AS "capturedAt"
    FROM rate_snapshots AS snapshot
    INNER JOIN corridors AS corridor ON corridor.id = snapshot.corridor_id
    WHERE snapshot.anchor_id = ${anchorId}::uuid
    ORDER BY corridor.slug, snapshot.captured_at DESC, snapshot.id DESC
  `;
}

// ─── Repositories built on the frozen queries ───────────────────────────────
// Everything except the latest-row query is the production code, so a
// difference between one of these and its production counterpart can only come
// from the query rewrite.

type LegacyObservationRow = Readonly<{
  id: string;
  anchorSlug: string;
  anchorName: string;
  rate: Prisma.Decimal;
  sourceAmount: Prisma.Decimal;
  destinationAmount: Prisma.Decimal;
  fee: Prisma.Decimal;
  capturedAt: Date;
}>;

/** The row mapping findLatestObservations applied before the rewrite. */
function toLegacyObservation(row: LegacyObservationRow): LatestRateRepositoryObservation {
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

export const LEGACY_LATEST_RATE_REPOSITORY: LatestRateRepository = Object.freeze({
  findCorridorBySlug: PRISMA_LATEST_RATE_REPOSITORY.findCorridorBySlug,
  async findLatestObservations(corridorId) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<LegacyObservationRow[]>(
      legacyLatestObservationsQuery(corridorId),
    );
    return Object.freeze(rows.map(toLegacyObservation));
  },
});

export const LEGACY_REPUTATION_REPOSITORY: ReputationRepository = Object.freeze({
  upsertScore: PRISMA_REPUTATION_REPOSITORY.upsertScore,
  async readEvidence(anchorSlug, outcomeWindowStart) {
    const evidence = await PRISMA_REPUTATION_REPOSITORY.readEvidence(
      anchorSlug,
      outcomeWindowStart,
    );
    if (!evidence || "code" in evidence) return evidence;

    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<Array<{ corridorSlug: string; capturedAt: Date }>>(
      legacyLatestCorridorRatesQuery(evidence.anchorId),
    );
    return Object.freeze({
      ...evidence,
      latestRates: Object.freeze(rows.map((rate) => Object.freeze({
        corridorSlug: rate.corridorSlug,
        capturedAt: new Date(rate.capturedAt.getTime()),
      }))),
    });
  },
});
