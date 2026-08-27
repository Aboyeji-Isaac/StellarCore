import { MIN_FRESH_SOURCES } from "@/constants/rates";
import {
  averageDecimals,
  compareDecimals,
  formatDecimal,
  isZeroDecimal,
  parseDatabaseDecimal,
  type ExactDecimal,
} from "@/lib/rates/decimal";
import { getRateFreshness } from "@/lib/rates/freshness";
import type {
  MedianExclusionReason,
  MedianResult,
  MedianSource,
  MedianSourceResult,
} from "@/types/rates";

export function computeFreshMedian(
  sources: readonly MedianSource[],
  now: Date = new Date(),
): MedianResult {
  const included: Array<{ decimal: ExactDecimal; source: MedianSourceResult }> = [];
  const sourceResults: MedianSourceResult[] = [];

  for (const source of sources) {
    const freshness = getRateFreshness(source.capturedAt, now);
    let reason: MedianExclusionReason | undefined;
    if (freshness.state === "stale") reason = "stale";
    if (freshness.state === "future") reason = "future_timestamp";
    if (freshness.state === "invalid") reason = "invalid_timestamp";

    let decimal: ExactDecimal | undefined;
    if (!reason) {
      try {
        decimal = parseDatabaseDecimal(source.rate);
        if (isZeroDecimal(decimal)) reason = "invalid_rate";
      } catch {
        reason = "invalid_rate";
      }
    }

    const result = Object.freeze({
      ...source,
      included: reason === undefined,
      ...(reason ? { exclusionReason: reason } : {}),
    });
    sourceResults.push(result);
    if (!reason && decimal) included.push({ decimal, source: result });
  }

  included.sort((left, right) => compareDecimals(left.decimal, right.decimal));
  let median: string | null = null;
  if (included.length >= MIN_FRESH_SOURCES) {
    const middle = Math.floor(included.length / 2);
    const value = included.length % 2 === 1
      ? included[middle]!.decimal
      : averageDecimals(included[middle - 1]!.decimal, included[middle]!.decimal);
    median = formatDecimal(value);
  }

  return Object.freeze({
    state: median === null ? "insufficient_fresh_sources" : "healthy",
    median,
    freshSourceCount: included.length,
    sources: Object.freeze(sourceResults),
  });
}
