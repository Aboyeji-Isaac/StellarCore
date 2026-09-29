import {
  addCounter,
  elapsedSeconds,
  instruments,
  markSpanError,
  recordHistogram,
  withSpan,
} from "@/lib/telemetry/core";
import { ATTR, type RefreshPhase } from "@/lib/telemetry/semantics";

export type PhaseItemCounts = Readonly<{
  succeeded: number;
  failed: number;
  skipped?: number;
}>;

type Outcome = "success" | "partial_failure" | "failure";

function outcomeOf(counts: PhaseItemCounts): Outcome {
  if (counts.failed === 0) return "success";
  return counts.succeeded > 0 ? "partial_failure" : "failure";
}

/**
 * Observes one scheduled refresh run. The run span is the parent of every
 * phase, SEP, and database span in the cycle. Durable run identity is owned
 * by #111; once it lands, its run id belongs on this span, not in metrics.
 */
export async function observeRefreshRun<T extends Readonly<{ ok: boolean }>>(
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  let outcome: Outcome = "failure";

  try {
    return await withSpan("stellarcore.refresh.run", {}, async (span) => {
      const result = await run();
      outcome = result.ok ? "success" : "partial_failure";
      span.setAttribute(ATTR.result, outcome);
      if (!result.ok) markSpanError(span, "PARTIAL_FAILURE");
      return result;
    });
  } finally {
    const attributes = { [ATTR.result]: outcome };
    addCounter(instruments().refreshRuns, 1, attributes);
    recordHistogram(instruments().refreshRunDuration, elapsedSeconds(startedAt), attributes);
  }
}

/** Observes one refresh phase and counts its items by typed result. */
export async function observeRefreshPhase<T>(
  phase: RefreshPhase,
  run: () => Promise<T>,
  count: (result: T) => PhaseItemCounts,
): Promise<T> {
  const startedAt = performance.now();
  const base = { [ATTR.refreshPhase]: phase };
  let outcome: Outcome = "failure";

  try {
    return await withSpan(`stellarcore.refresh.phase ${phase}`, base, async (span) => {
      const result = await run();
      const counts = count(result);
      outcome = outcomeOf(counts);
      span.setAttribute(ATTR.result, outcome);
      if (outcome !== "success") markSpanError(span, outcome.toUpperCase());
      for (const [itemResult, value] of [
        ["succeeded", counts.succeeded],
        ["failed", counts.failed],
        ["skipped", counts.skipped ?? 0],
      ] as const) {
        if (value > 0) {
          addCounter(instruments().refreshPhaseItems, value, {
            ...base,
            [ATTR.refreshItemResult]: itemResult,
          });
        }
      }
      return result;
    });
  } finally {
    recordHistogram(instruments().refreshPhaseDuration, elapsedSeconds(startedAt), {
      ...base,
      [ATTR.result]: outcome,
    });
  }
}

export type ObservedFreshness = Readonly<{
  freshnessState: string;
  ageMs: number | null;
}>;

/**
 * Counts persisted latest-rate observations by their already-evaluated
 * freshness state. It reads nothing new and never creates or refreshes rate
 * evidence; it only describes what a read returned.
 */
export function recordRateObservationFreshness(observations: readonly ObservedFreshness[]): void {
  for (const observation of observations) {
    const attributes = { [ATTR.freshnessState]: observation.freshnessState };
    addCounter(instruments().rateObservations, 1, attributes);
    if (typeof observation.ageMs === "number" && Number.isFinite(observation.ageMs) && observation.ageMs >= 0) {
      recordHistogram(instruments().rateObservationAge, observation.ageMs / 1000, attributes);
    }
  }
}
