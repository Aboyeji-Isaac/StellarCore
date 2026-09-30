import type { RateEngineFailure } from "@/types/rates";

export type ScheduledRateFailure = RateEngineFailure | Readonly<{
  phase: "PREPARATION";
  code: "LIVE_RATE_PREPARATION_FAILURE";
}>;

export type ScheduledReputationFailure = Readonly<{
  anchorSlug: string;
  code: string;
}>;

/**
 * Terminal state of one scheduled-refresh attempt.
 *
 * - succeeded: every required phase reached its success state.
 * - partially_succeeded: at least one phase succeeded and at least one did
 *   not; partial completion is never reported as success.
 * - failed: no phase succeeded, or the run was interrupted.
 * - already_running: another execution owns the advisory lock. The payload
 *   carries an ephemeral attempt id in runId (never persisted) and, when
 *   known, the conflicting persisted run in activeRunId. No phase work ran.
 */
export type ScheduledRefreshState =
  | "succeeded"
  | "partially_succeeded"
  | "failed"
  | "already_running";

export type ScheduledRefreshResult = Readonly<{
  ok: boolean;
  runId: string;
  state: ScheduledRefreshState;
  activeRunId?: string | null | undefined;
  resumedFromId?: string | null | undefined;
  startedAt: string;
  completedAt: string;
  rates: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    failures: readonly ScheduledRateFailure[];
  }>;
  reputation: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    failures: readonly ScheduledReputationFailure[];
  }>;
}>;
