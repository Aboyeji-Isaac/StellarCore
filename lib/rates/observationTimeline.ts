import { Prisma } from "@/app/generated/prisma/client";
import { latestDispositionJoin, toBlockingDisposition } from "@/lib/rates/disposition";
import { PRISMA_LATEST_RATE_REPOSITORY } from "@/lib/rates/latestRateRepository";
import type { LatestRateRepositoryCorridor, ObservationDisposition } from "@/types/latestRates";

/**
 * Disposition-aware historical read of individual persisted observations.
 * Every stored point is returned exactly once, in capture order, with its
 * current disposition. Blocked points stay in the timeline flagged
 * `usable: false`. Nothing is interpolated, aggregated, or replaced, so a
 * chart must render them as flagged points or gaps. Historical presentation
 * (#31) should consume this rather than reading rate_snapshots directly.
 */
export type TimelinePoint = Readonly<{
  snapshotId: string;
  anchorSlug: string;
  rate: string;
  capturedAt: string;
  usable: boolean;
  disposition?: ObservationDisposition;
}>;

export type ObservationTimeline =
  | Readonly<{
      ok: true;
      corridorSlug: string;
      from: string;
      to: string;
      points: readonly TimelinePoint[];
      truncated: boolean;
    }>
  | Readonly<{
      ok: false;
      code: "INVALID_RANGE" | "CORRIDOR_NOT_FOUND" | "READ_FAILURE";
    }>;

export type TimelineRow = Readonly<{
  id: string;
  anchorSlug: string;
  rate: string;
  capturedAt: Date;
  dispositionAction: string | null;
  dispositionReason: string | null;
  dispositionRecordedAt: Date | null;
}>;

export type ObservationTimelineRepository = Readonly<{
  findCorridorBySlug: (slug: string) => Promise<LatestRateRepositoryCorridor | null>;
  findObservations: (corridorId: string, from: Date, to: Date, limit: number) => Promise<readonly TimelineRow[]>;
}>;

export const MAX_TIMELINE_RANGE_MS = 366 * 86_400_000;
export const MAX_TIMELINE_POINTS = 5_000;

export async function readRateObservationTimeline(
  corridorSlug: string,
  range: Readonly<{ from: Date; to: Date }>,
  repository: ObservationTimelineRepository = PRISMA_OBSERVATION_TIMELINE_REPOSITORY,
): Promise<ObservationTimeline> {
  const from = range.from.getTime();
  const to = range.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_TIMELINE_RANGE_MS) {
    return Object.freeze({ ok: false, code: "INVALID_RANGE" });
  }

  try {
    const corridor = await repository.findCorridorBySlug(corridorSlug);
    if (!corridor) return Object.freeze({ ok: false, code: "CORRIDOR_NOT_FOUND" });
    const rows = await repository.findObservations(corridor.id, range.from, range.to, MAX_TIMELINE_POINTS + 1);
    const points = rows.slice(0, MAX_TIMELINE_POINTS).map((row) => {
      const disposition = toBlockingDisposition(row.dispositionAction, row.dispositionReason, row.dispositionRecordedAt);
      return Object.freeze({
        snapshotId: row.id,
        anchorSlug: row.anchorSlug,
        rate: row.rate,
        capturedAt: row.capturedAt.toISOString(),
        usable: disposition === null,
        ...(disposition ? { disposition } : {}),
      });
    });
    return Object.freeze({
      ok: true,
      corridorSlug: corridor.slug,
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      points: Object.freeze(points),
      truncated: rows.length > MAX_TIMELINE_POINTS,
    });
  } catch {
    return Object.freeze({ ok: false, code: "READ_FAILURE" });
  }
}

export const PRISMA_OBSERVATION_TIMELINE_REPOSITORY: ObservationTimelineRepository = Object.freeze({
  findCorridorBySlug: PRISMA_LATEST_RATE_REPOSITORY.findCorridorBySlug,

  async findObservations(corridorId, from, to, limit) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<(Omit<TimelineRow, "rate"> & { rate: Prisma.Decimal })[]>(Prisma.sql`
      SELECT
        observation.id,
        observation."anchorSlug",
        observation.rate,
        observation."capturedAt",
        disposition.action AS "dispositionAction",
        disposition.reason_code AS "dispositionReason",
        disposition.recorded_at AS "dispositionRecordedAt"
      FROM (
        SELECT snapshot.id, anchor.slug AS "anchorSlug", snapshot.rate,
               snapshot.captured_at AS "capturedAt"
          FROM rate_snapshots AS snapshot
          INNER JOIN anchors AS anchor ON anchor.id = snapshot.anchor_id
         WHERE snapshot.corridor_id = ${corridorId}::uuid
           AND snapshot.captured_at >= ${from}
           AND snapshot.captured_at < ${to}
         ORDER BY snapshot.captured_at ASC, snapshot.id ASC
         LIMIT ${limit}
      ) AS observation
      ${Prisma.raw(latestDispositionJoin("observation"))}
      ORDER BY observation."capturedAt" ASC, observation.id ASC
    `);
    return Object.freeze(rows.map((row) => Object.freeze({ ...row, rate: row.rate.toString() })));
  },
});
