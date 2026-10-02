import {
  CLOCK_MAXIMUM_SKEW_MS,
  CLOCK_SKEW_METADATA_BOUND_MS,
} from "@/constants/clock";
import { isValidClockInstant, SYSTEM_CLOCK } from "@/lib/clock/clock";
import type {
  ClockIntegrityBoundary,
  ClockIntegrityCheckRecord,
  ClockIntegrityFailureCode,
  ClockIntegrityGuard,
  ClockIntegrityRecorder,
  ClockIntegrityVerdict,
  ClockSkewDirection,
  DatabaseClockReader,
  ServerClock,
} from "@/types/clock";

export type ClockIntegrityAssessmentInput = Readonly<{
  boundary: ClockIntegrityBoundary;
  applicationTime: Date | null;
  databaseTime: Date | null;
  toleranceMs: number;
  runId?: string | null;
  /** True when the PostgreSQL clock could not be read at all. */
  readFailure?: boolean;
}>;

/**
 * Pure decision function shared by the live gate and its unit tests. It never
 * inspects or echoes any input other than the two instants.
 */
export function assessClockIntegrity(
  input: ClockIntegrityAssessmentInput,
): ClockIntegrityVerdict {
  const runId = normalizeRunId(input.runId);
  const base = Object.freeze({
    boundary: input.boundary,
    toleranceMs: input.toleranceMs,
    runId,
  });

  if (input.readFailure) {
    return rejected(base, "CLOCK_READ_FAILURE", {
      direction: "UNKNOWN",
      skewMs: null,
      applicationTime: null,
      databaseTime: null,
    });
  }

  if (
    !isValidClockInstant(input.applicationTime)
    || !isValidClockInstant(input.databaseTime)
  ) {
    return rejected(base, "INVALID_CLOCK_VALUE", {
      direction: "UNKNOWN",
      skewMs: null,
      applicationTime: toIso(input.applicationTime),
      databaseTime: toIso(input.databaseTime),
    });
  }

  const rawSkewMs = input.applicationTime.getTime() - input.databaseTime.getTime();
  const detail = Object.freeze({
    direction: directionOf(rawSkewMs),
    skewMs: clampSkew(rawSkewMs),
    applicationTime: input.applicationTime.toISOString(),
    databaseTime: input.databaseTime.toISOString(),
  });

  if (Math.abs(rawSkewMs) > input.toleranceMs) {
    return rejected(base, "CLOCK_SKEW_EXCEEDED", detail);
  }

  return Object.freeze({
    ...base,
    outcome: "PASSED" as const,
    code: null,
    ...detail,
  });
}

export type ClockIntegrityDependencies = Readonly<{
  reader: DatabaseClockReader;
  clock?: ServerClock;
  recorder?: ClockIntegrityRecorder | null;
  toleranceMs?: number;
  runId?: string | null;
}>;

/**
 * Performs the clock comparison at a persisted-evidence boundary. The whole gate
 * is exactly one PostgreSQL round trip when a recorder is configured, and never
 * throws: read failures degrade to a sanitized rejected verdict so a broken
 * clock can never be mistaken for a healthy one.
 */
export async function checkClockIntegrity(
  boundary: ClockIntegrityBoundary,
  dependencies: ClockIntegrityDependencies,
): Promise<ClockIntegrityVerdict> {
  const clock = dependencies.clock ?? SYSTEM_CLOCK;
  const toleranceMs = dependencies.toleranceMs ?? CLOCK_MAXIMUM_SKEW_MS;

  let applicationTime: Date | null = null;
  try {
    applicationTime = clock.now();
  } catch {
    applicationTime = null;
  }

  let databaseTime: Date | null = null;
  let readFailure = false;
  try {
    databaseTime = await dependencies.reader.readDatabaseTime();
  } catch {
    readFailure = true;
  }

  let verdict = assessClockIntegrity({
    boundary,
    applicationTime,
    databaseTime,
    toleranceMs,
    runId: dependencies.runId,
    readFailure,
  });

  if (
    dependencies.recorder
    && !readFailure
    && applicationTime !== null
    && databaseTime !== null
  ) {
    try {
      await dependencies.recorder.record(toPersistenceRecord(verdict));
    } catch {
      // Fail closed: if the run cannot retain its integrity metadata, no
      // evidence is persisted under an unverifiable clock.
      if (verdict.outcome === "PASSED") {
        verdict = withRejection(verdict, "CLOCK_METADATA_PERSISTENCE_FAILURE");
      }
    }
  }

  return verdict;
}

export function createClockIntegrityGuard(
  boundary: ClockIntegrityBoundary,
  dependencies: ClockIntegrityDependencies,
): ClockIntegrityGuard {
  return Object.freeze({
    check: () => checkClockIntegrity(boundary, dependencies),
  });
}

export function toPersistenceRecord(
  verdict: ClockIntegrityVerdict,
): ClockIntegrityCheckRecord {
  return Object.freeze({
    boundary: verdict.boundary,
    outcome: verdict.outcome,
    code: verdict.code,
    runId: verdict.runId,
    applicationTime: verdict.applicationTime === null
      ? null
      : new Date(verdict.applicationTime),
    databaseTime: verdict.databaseTime === null
      ? null
      : new Date(verdict.databaseTime),
    skewMs: verdict.skewMs,
    toleranceMs: verdict.toleranceMs,
  });
}

function rejected(
  base: Readonly<{ boundary: ClockIntegrityBoundary; toleranceMs: number; runId: string | null }>,
  code: ClockIntegrityFailureCode,
  detail: Readonly<{
    direction: ClockSkewDirection;
    skewMs: number | null;
    applicationTime: string | null;
    databaseTime: string | null;
  }>,
): ClockIntegrityVerdict {
  return Object.freeze({
    ...base,
    outcome: "REJECTED" as const,
    code,
    ...detail,
  });
}

function withRejection(
  verdict: ClockIntegrityVerdict,
  code: ClockIntegrityFailureCode,
): ClockIntegrityVerdict {
  return Object.freeze({ ...verdict, outcome: "REJECTED" as const, code });
}

function directionOf(skewMs: number): ClockSkewDirection {
  if (skewMs > 0) return "POSITIVE";
  if (skewMs < 0) return "NEGATIVE";
  return "NONE";
}

function clampSkew(skewMs: number): number {
  if (skewMs > CLOCK_SKEW_METADATA_BOUND_MS) return CLOCK_SKEW_METADATA_BOUND_MS;
  if (skewMs < -CLOCK_SKEW_METADATA_BOUND_MS) return -CLOCK_SKEW_METADATA_BOUND_MS;
  return Math.trunc(skewMs);
}

function normalizeRunId(runId: string | null | undefined): string | null {
  if (typeof runId !== "string") return null;
  const trimmed = runId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toIso(value: Date | null): string | null {
  return isValidClockInstant(value) ? value.toISOString() : null;
}
