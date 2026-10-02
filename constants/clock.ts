/**
 * Reviewed maximum disagreement between the application clock and PostgreSQL
 * before a persisted-evidence boundary is rejected. It is intentionally much
 * smaller than the 120-second rate freshness window (`constants/rates.ts`) so
 * tolerable skew can never make an observation look fresh that is not.
 */
export const CLOCK_MAXIMUM_SKEW_MS = 5_000;

/**
 * Upper bound applied to persisted/echoed skew metadata so a pathologically
 * wrong clock cannot store an unbounded integer. Values beyond this are clamped
 * in either direction and the rejection is still reported as skew exceeded.
 */
export const CLOCK_SKEW_METADATA_BOUND_MS = 24 * 60 * 60 * 1_000;

/**
 * Field-length bounds for persisted clock-integrity metadata. They match the
 * CHECK constraints added in the `add_clock_integrity_checks` migration.
 */
export const CLOCK_INTEGRITY_METADATA_LIMITS = Object.freeze({
  code: 64,
  runId: 100,
} as const);
