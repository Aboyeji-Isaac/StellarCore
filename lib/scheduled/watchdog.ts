import {
  REFRESH_CADENCE_MS,
  REFRESH_GRACE_MS,
  REFRESH_SLOT_OFFSET_MS,
} from "@/constants/refresh";
import type { ScheduledRefreshResult } from "@/types/scheduled";
import type {
  RefreshLatestRunState,
  RefreshRunOutcome,
  RefreshWatchdogState,
  RefreshWatchdogStatus,
} from "@/types/refreshWatchdog";

export type RefreshRunClassification = Readonly<{
  outcome: RefreshRunOutcome;
  failureCode: string | null;
}>;

/**
 * Classifies a completed scheduler cycle by the evidence it produced, never by
 * the fact that it started:
 *
 * - successful: no rate or reputation failures and at least one rate snapshot
 *   was persisted.
 * - failed: nothing was produced (no rate snapshot and no reputation
 *   evaluation succeeded).
 * - partial: anything else, i.e. some evidence was produced but not all.
 */
export function classifyRefreshRun(result: ScheduledRefreshResult): RefreshRunClassification {
  const { rates, reputation } = result;
  if (rates.succeeded === 0 && reputation.succeeded === 0) {
    return Object.freeze({ outcome: "failed", failureCode: "NO_EVIDENCE_PRODUCED" });
  }
  if (rates.failed > 0) {
    return Object.freeze({ outcome: "partial", failureCode: "RATE_SOURCE_FAILURES" });
  }
  if (reputation.failed > 0) {
    return Object.freeze({ outcome: "partial", failureCode: "REPUTATION_FAILURES" });
  }
  if (rates.succeeded === 0) {
    return Object.freeze({ outcome: "partial", failureCode: "NO_RATE_EVIDENCE" });
  }
  return Object.freeze({ outcome: "successful", failureCode: null });
}

/** Records that a run began. Never touches the success heartbeat. */
export function applyRunStarted(
  current: RefreshWatchdogState | null,
  pipeline: string,
  runId: string,
  startedAt: Date,
): RefreshWatchdogState {
  const base = current ?? initialState(pipeline, startedAt);
  return Object.freeze({
    ...base,
    lastRunId: runId,
    lastRunStartedAt: startedAt,
    lastRunCompletedAt: null,
    lastRunOutcome: null,
    lastRunFailureCode: null,
  });
}

/**
 * Records a run's completion. The latest-run fields change only when this is
 * still the most recently started run, so an older overlapping run cannot
 * overwrite a newer one. The success heartbeat advances only for a successful
 * outcome and never moves backwards; failed and partial runs leave it alone.
 */
export function applyRunCompleted(
  current: RefreshWatchdogState | null,
  pipeline: string,
  run: Readonly<{ runId: string; startedAt: Date; completedAt: Date }>,
  classification: RefreshRunClassification,
): RefreshWatchdogState {
  const { runId, startedAt, completedAt } = run;
  const base = current ?? initialState(pipeline, completedAt);
  const successful = classification.outcome === "successful";
  const heartbeat = successful &&
      (!base.lastSuccessfulRefreshAt ||
        completedAt.getTime() > base.lastSuccessfulRefreshAt.getTime())
    ? completedAt
    : base.lastSuccessfulRefreshAt;
  // Also true when this run's start was never recorded (the start write
  // failed) and no newer run has started since.
  const isLatestRun = base.lastRunId === runId ||
    !base.lastRunStartedAt ||
    startedAt.getTime() >= base.lastRunStartedAt.getTime();

  return Object.freeze({
    ...base,
    lastSuccessfulRefreshAt: heartbeat,
    ...(isLatestRun
      ? {
        lastRunId: runId,
        lastRunStartedAt: startedAt,
        lastRunCompletedAt: completedAt,
        lastRunOutcome: classification.outcome,
        lastRunFailureCode: classification.failureCode,
        consecutiveUnsuccessfulRuns: successful ? 0 : base.consecutiveUnsuccessfulRuns + 1,
      }
      : {}),
  });
}

/** The first scheduled slot strictly after the given instant. */
export function nextScheduledSlotAfter(instant: Date): Date {
  const elapsed = instant.getTime() - REFRESH_SLOT_OFFSET_MS;
  const slot = Math.floor(elapsed / REFRESH_CADENCE_MS) * REFRESH_CADENCE_MS +
    REFRESH_SLOT_OFFSET_MS + REFRESH_CADENCE_MS;
  return new Date(slot);
}

/**
 * Evaluates freshness from durable state plus the supplied clock only.
 *
 * The reference is the last successful refresh, or the tracking start when no
 * run has ever succeeded. The next refresh is expected at the first scheduled
 * slot strictly after the reference; staleAt is that slot plus the grace
 * period. The boundary is inclusive, matching rate freshness: evidence is
 * still within its window at exactly staleAt and stale one millisecond later.
 */
export function evaluateRefreshWatchdog(
  state: RefreshWatchdogState | null,
  now: Date,
  pipeline: string,
): RefreshWatchdogStatus {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid evaluation time");
  if (!state) {
    return Object.freeze({
      pipeline,
      evaluatedAt: now.toISOString(),
      state: "stale",
      staleReason: "no_watchdog_state",
      lastSuccessfulRefreshAt: null,
      expectedRefreshAt: null,
      staleAt: null,
      cadenceMs: REFRESH_CADENCE_MS,
      graceMs: REFRESH_GRACE_MS,
      consecutiveUnsuccessfulRuns: 0,
      latestRun: Object.freeze({ state: "none", startedAt: null, completedAt: null, failureCode: null }),
    });
  }

  const reference = state.lastSuccessfulRefreshAt ?? state.trackingSince;
  const expectedRefreshAt = nextScheduledSlotAfter(reference);
  const staleAt = new Date(expectedRefreshAt.getTime() + REFRESH_GRACE_MS);
  const stale = now.getTime() > staleAt.getTime();
  const latestRunState = latestRun(state);
  const lastCompletedUnsuccessful = latestRunState === "failed" ||
    latestRunState === "partial" ||
    (latestRunState === "in_progress" && state.consecutiveUnsuccessfulRuns > 0);

  const freshness = stale
    ? "stale"
    : !state.lastSuccessfulRefreshAt
      ? "awaiting_first_refresh"
      : lastCompletedUnsuccessful
        ? "degraded"
        : "fresh";

  return Object.freeze({
    pipeline: state.pipeline,
    evaluatedAt: now.toISOString(),
    state: freshness,
    staleReason: stale
      ? state.lastSuccessfulRefreshAt ? "missed_expected_refresh" : "no_successful_refresh"
      : null,
    lastSuccessfulRefreshAt: state.lastSuccessfulRefreshAt?.toISOString() ?? null,
    expectedRefreshAt: expectedRefreshAt.toISOString(),
    staleAt: staleAt.toISOString(),
    cadenceMs: REFRESH_CADENCE_MS,
    graceMs: REFRESH_GRACE_MS,
    consecutiveUnsuccessfulRuns: state.consecutiveUnsuccessfulRuns,
    latestRun: Object.freeze({
      state: latestRunState,
      startedAt: state.lastRunStartedAt?.toISOString() ?? null,
      completedAt: state.lastRunCompletedAt?.toISOString() ?? null,
      failureCode: state.lastRunFailureCode,
    }),
  });
}

function latestRun(state: RefreshWatchdogState): RefreshLatestRunState {
  if (!state.lastRunStartedAt && !state.lastRunOutcome) return "none";
  return state.lastRunOutcome ?? "in_progress";
}

function initialState(pipeline: string, trackingSince: Date): RefreshWatchdogState {
  return Object.freeze({
    pipeline,
    trackingSince,
    lastRunId: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunOutcome: null,
    lastRunFailureCode: null,
    lastSuccessfulRefreshAt: null,
    consecutiveUnsuccessfulRuns: 0,
  });
}
