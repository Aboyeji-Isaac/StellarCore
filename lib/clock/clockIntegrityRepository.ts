import { Prisma } from "@/app/generated/prisma/client";
import { createClockIntegrityGuard } from "@/lib/clock/integrity";
import type {
  ClockIntegrityCheckRecord,
  ClockIntegrityGuard,
  ClockIntegrityRecorder,
  DatabaseClockReader,
} from "@/types/clock";

type DatabaseClockRow = Readonly<{ databaseTime: Date }>;

/**
 * Authoritative PostgreSQL wall clock. `clock_timestamp()` is the instant the
 * function executes (not the surrounding transaction start), which is the
 * correct reference for detecting application-clock drift.
 */
export const PRISMA_DATABASE_CLOCK_READER: DatabaseClockReader = Object.freeze({
  async readDatabaseTime(): Promise<Date> {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.$queryRaw<DatabaseClockRow[]>(
      Prisma.sql`SELECT clock_timestamp() AS "databaseTime"`,
    );
    const value = rows[0]?.databaseTime;
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new Error("Database clock returned no usable value");
    }
    return new Date(value.getTime());
  },
});

/**
 * Persists one bounded run/provenance row per gate check. Rejected checks are
 * retained (quarantined) rather than silently discarded.
 */
export const PRISMA_CLOCK_INTEGRITY_RECORDER: ClockIntegrityRecorder =
  Object.freeze({
    async record(check: ClockIntegrityCheckRecord): Promise<void> {
      const { db } = await import("@/lib/dbClient");
      await db.clockIntegrityCheck.create({
        data: {
          boundary: check.boundary,
          outcome: check.outcome,
          code: check.code,
          runId: check.runId,
          applicationTime: check.applicationTime,
          databaseTime: check.databaseTime,
          skewMs: check.skewMs,
          toleranceMs: check.toleranceMs,
        },
      });
    },
  });

function guard(boundary: "RATE_CAPTURE" | "REPUTATION_EVALUATION"): ClockIntegrityGuard {
  return createClockIntegrityGuard(boundary, {
    reader: PRISMA_DATABASE_CLOCK_READER,
    recorder: PRISMA_CLOCK_INTEGRITY_RECORDER,
  });
}

/** Production gate for the rate-capture run. */
export const PRISMA_RATE_CAPTURE_CLOCK_GUARD = guard("RATE_CAPTURE");

/** Production gate for the reputation-evaluation run. */
export const PRISMA_REPUTATION_CLOCK_GUARD = guard("REPUTATION_EVALUATION");
