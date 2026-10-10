import type { RateEngineFailure } from "@/types/rates";

export type ScheduledRateFailure = RateEngineFailure | Readonly<{
  phase: "PREPARATION";
  code: "LIVE_RATE_PREPARATION_FAILURE";
}>;

export type ScheduledReputationFailure = Readonly<{
  anchorSlug: string;
  code: string;
}>;

/// Failure classes eligible for durable suppression. Only deterministic
/// configuration or protocol failures are eligible; transient failures must
/// continue through the normal breaker/retry logic.
export type ScheduledSourceSuppressionReason =
  | "PERMANENT_CONFIGURATION"
  | "PERMANENT_PROTOCOL";

export type ScheduledSourceSuppressionState = "ACTIVE" | "REACTIVATED";

export type ScheduledSourceSuppression = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  reason: ScheduledSourceSuppressionReason;
  state: ScheduledSourceSuppressionState;
  failureCode: string;
  failurePhase: string;
  consecutiveFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
  suppressedAt: string;
  reactivatedAt: string | null;
  reactivationReason: string | null;
}>;

export type ScheduledRefreshResult = Readonly<{
  ok: boolean;
  startedAt: string;
  completedAt: string;
  rates: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    skipped: number;
    suppressed: number;
    failures: readonly ScheduledRateFailure[];
  }>;
  reputation: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    failures: readonly ScheduledReputationFailure[];
  }>;
}>;
