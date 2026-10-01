import type { RateEngineFailure } from "@/types/rates";

export const PERMANENT_FAILURE_SUPPRESSION_THRESHOLD = 3;

export type ScheduledSuppressionReason =
  | "PERMANENT_CONFIGURATION"
  | "PERMANENT_PROTOCOL";

const PERMANENT_NORMALIZATION_CODES = new Set([
  "INVALID_ANCHOR",
  "INVALID_CORRIDOR",
  "ASSET_MISMATCH",
  "INVALID_RATE",
  "INVALID_SOURCE_AMOUNT",
  "INVALID_DESTINATION_AMOUNT",
  "INVALID_FEE",
  "UNSUPPORTED_FEE_ASSET",
  "INVALID_TIMESTAMP",
  "ARITHMETIC_INCONSISTENCY",
]);

export function classifyPermanentScheduledFailure(
  failure: RateEngineFailure,
): ScheduledSuppressionReason | null {
  if (failure.phase !== "NORMALIZATION") return null;
  if (!PERMANENT_NORMALIZATION_CODES.has(failure.code)) return null;

  return failure.code === "INVALID_ANCHOR" || failure.code === "INVALID_CORRIDOR"
    ? "PERMANENT_CONFIGURATION"
    : "PERMANENT_PROTOCOL";
}


export type SuppressionCounterState = Readonly<{
  state: "ACTIVE" | "SUPPRESSED";
  consecutiveFailures: number;
  suppressedAt: Date | null;
}>;

export function advancePermanentSuppression(
  previous: SuppressionCounterState | null,
  observedAt: Date,
): SuppressionCounterState {
  if (previous?.state === "SUPPRESSED") {
    return Object.freeze({
      state: "SUPPRESSED",
      consecutiveFailures: previous.consecutiveFailures,
      suppressedAt: previous.suppressedAt,
    });
  }

  const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
  const shouldSuppress =
    consecutiveFailures >= PERMANENT_FAILURE_SUPPRESSION_THRESHOLD;

  return Object.freeze({
    state: shouldSuppress ? "SUPPRESSED" : "ACTIVE",
    consecutiveFailures,
    suppressedAt:
      shouldSuppress ? previous?.suppressedAt ?? new Date(observedAt) : null,
  });
}

export function reactivatePermanentSuppression(): SuppressionCounterState {
  return Object.freeze({
    state: "ACTIVE",
    consecutiveFailures: 0,
    suppressedAt: null,
  });
}
