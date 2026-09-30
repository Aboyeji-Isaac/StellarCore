import { Prisma } from "@/app/generated/prisma/client";

import type { EvidenceIntegrityIssue } from "@/lib/evidence/integrity";

/**
 * The one definition of a usable rate snapshot, evaluated in SQL so a corrupt
 * row can never win a DISTINCT ON "latest" selection and shadow valid history.
 * Expects the snapshot table to be aliased `snapshot`.
 */
export const VALID_RATE_SNAPSHOT = Prisma.sql`(
  isfinite(snapshot.captured_at)
  AND snapshot.rate <> 'NaN'::numeric AND snapshot.rate > 0
  AND snapshot.source_amount <> 'NaN'::numeric AND snapshot.source_amount > 0
  AND snapshot.destination_amount <> 'NaN'::numeric AND snapshot.destination_amount > 0
  AND snapshot.fee <> 'NaN'::numeric AND snapshot.fee >= 0
)`;

/** SELECT list classifying a snapshot that fails VALID_RATE_SNAPSHOT. */
export const RATE_SNAPSHOT_CORRUPTION_CLASS = Prisma.sql`(
  CASE
    WHEN NOT isfinite(snapshot.captured_at) THEN 'INVALID_TIMESTAMP'
    WHEN snapshot.rate = 'NaN'::numeric
      OR snapshot.source_amount = 'NaN'::numeric
      OR snapshot.destination_amount = 'NaN'::numeric
      OR snapshot.fee = 'NaN'::numeric THEN 'INVALID_NUMBER'
    ELSE 'OUT_OF_RANGE'
  END
)`;

export type CorruptSnapshotRow = Readonly<{
  id: string;
  class: EvidenceIntegrityIssue["class"];
  anchorSlug: string;
  corridorSlug: string;
  total: bigint | number;
}>;

export function toSnapshotIssue(row: CorruptSnapshotRow): EvidenceIntegrityIssue {
  return Object.freeze({
    source: "rate_snapshot",
    class: row.class,
    recordId: row.id,
    anchorSlug: row.anchorSlug,
    corridorSlug: row.corridorSlug,
  });
}
