/**
 * One server-side clock abstraction for evidence capture and evaluation.
 *
 * Everything that stamps or evaluates persisted evidence must read time through
 * this interface instead of calling `new Date()` directly, so controlled clocks
 * used by tests flow through the unchanged production boundary.
 */
export type ServerClock = Readonly<{
  now: () => Date;
}>;

export type ClockIntegrityBoundary =
  | "RATE_CAPTURE"
  | "REPUTATION_EVALUATION";

export type ClockIntegrityFailureCode =
  | "CLOCK_SKEW_EXCEEDED"
  | "CLOCK_READ_FAILURE"
  | "INVALID_CLOCK_VALUE"
  | "CLOCK_METADATA_PERSISTENCE_FAILURE";

/**
 * `POSITIVE` means the application clock is ahead of PostgreSQL (future
 * observations); `NEGATIVE` means it lags (extended freshness). `UNKNOWN` is
 * used when no comparison could be made.
 */
export type ClockSkewDirection = "POSITIVE" | "NEGATIVE" | "NONE" | "UNKNOWN";

/**
 * A sanitized, JSON-safe account of one clock-integrity decision. It contains
 * only enum literals, ISO-8601 UTC strings, and bounded numbers, so it is safe
 * to persist, log, or return to operators without leaking configuration or
 * stack traces.
 */
export type ClockIntegrityVerdict = Readonly<{
  boundary: ClockIntegrityBoundary;
  outcome: "PASSED" | "REJECTED";
  code: ClockIntegrityFailureCode | null;
  direction: ClockSkewDirection;
  /** applicationTime - databaseTime, clamped to the metadata bound. */
  skewMs: number | null;
  toleranceMs: number;
  /** ISO-8601 UTC, or null when unavailable. */
  applicationTime: string | null;
  /** ISO-8601 UTC, or null when unavailable. */
  databaseTime: string | null;
  runId: string | null;
}>;

/** Reads the authoritative time from PostgreSQL. */
export type DatabaseClockReader = Readonly<{
  readDatabaseTime: () => Promise<Date>;
}>;

/** Bounded metadata written alongside a run/provenance record. */
export type ClockIntegrityCheckRecord = Readonly<{
  boundary: ClockIntegrityBoundary;
  outcome: "PASSED" | "REJECTED";
  code: ClockIntegrityFailureCode | null;
  runId: string | null;
  applicationTime: Date | null;
  databaseTime: Date | null;
  skewMs: number | null;
  toleranceMs: number;
}>;

export type ClockIntegrityRecorder = Readonly<{
  record: (check: ClockIntegrityCheckRecord) => Promise<void>;
}>;

/**
 * Run-level gate. One `check()` call performs a single database round trip for
 * a whole capture/evaluation run, so it is never invoked per row.
 */
export type ClockIntegrityGuard = Readonly<{
  check: () => Promise<ClockIntegrityVerdict>;
}>;
