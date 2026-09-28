import {
  RATE_CAPTURE_MAX_INTERVAL_MS,
  RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
  RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
} from "@/constants/scheduling";
import type { CaptureCadenceHealth } from "@/types/scheduling";

/**
 * What the cadence signal is explicitly not evidence of. It is published with
 * every reading so operators cannot mistake scheduler health for anchor health
 * or for rate evidence.
 */
export const CAPTURE_CADENCE_NOT_EVIDENCE_OF: readonly string[] = Object.freeze([
  "anchor_reachability",
  "price_or_quote_availability",
  "transfer_execution_success",
  "rate_freshness_or_median_eligibility",
]);

export type CaptureCadenceHealthInput = Readonly<{
  lastCompletedRunAt: Date | string | null;
  scheduledIntervalMs: number | null;
  now: Date;
}>;

/**
 * Derives missed-run / cadence health from the durable capture-run lineage.
 *
 * It answers exactly one question: did StellarCore's capture process run when
 * the contract said it would? It never reads rate snapshots, never labels a
 * last known value fresh, and never creates or backfills an observation. A
 * delayed or missed run surfaces as `delayed` or `missed` here while the rate
 * read path independently reports the persisted evidence as stale.
 */
export function evaluateCaptureCadenceHealth(
  input: CaptureCadenceHealthInput,
): CaptureCadenceHealth {
  const lastMs = toMillis(input.lastCompletedRunAt);
  const scheduledIntervalMs =
    typeof input.scheduledIntervalMs === "number" && input.scheduledIntervalMs > 0
      ? input.scheduledIntervalMs
      : null;

  if (lastMs === null || scheduledIntervalMs === null) {
    return Object.freeze({
      state: "unknown",
      scheduledIntervalMs,
      lastCompletedRunAt: lastMs === null
        ? null
        : new Date(lastMs).toISOString(),
      ageMs: null,
      missedIntervals: null,
      contractVersion: RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
      signalScope: "stellarcore_capture_process",
      notEvidenceOf: CAPTURE_CADENCE_NOT_EVIDENCE_OF,
    });
  }

  const ageMs = Math.max(0, input.now.getTime() - lastMs);
  const expectedBudgetMs = Math.min(
    scheduledIntervalMs + RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
    RATE_CAPTURE_MAX_INTERVAL_MS,
  );

  const state = ageMs <= expectedBudgetMs
    ? "healthy"
    : ageMs <= RATE_CAPTURE_MAX_INTERVAL_MS
      ? "delayed"
      : "missed";

  return Object.freeze({
    state,
    scheduledIntervalMs,
    lastCompletedRunAt: new Date(lastMs).toISOString(),
    ageMs,
    missedIntervals: countMissedIntervals(
      state,
      ageMs,
      scheduledIntervalMs,
    ),
    contractVersion: RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
    signalScope: "stellarcore_capture_process",
    notEvidenceOf: CAPTURE_CADENCE_NOT_EVIDENCE_OF,
  });
}

/**
 * Whole capture intervals the process actually failed to observe.
 *
 * A healthy tick misses nothing, a delayed tick has missed exactly the one it
 * is late for, and a missed run adds every further whole interval that elapsed
 * beyond the largest interval the contract supports. This is a statement about
 * StellarCore's scheduler, never about an anchor.
 */
function countMissedIntervals(
  state: "healthy" | "delayed" | "missed",
  ageMs: number,
  scheduledIntervalMs: number,
): number {
  if (state === "healthy") return 0;
  if (state === "delayed") return 1;
  return 1 + Math.floor((ageMs - RATE_CAPTURE_MAX_INTERVAL_MS) / scheduledIntervalMs);
}

function toMillis(value: Date | string | null): number | null {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}
