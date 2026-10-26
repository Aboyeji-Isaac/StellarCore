import type { RateEngineFailure } from "@/types/rates";

export type ScheduledRateFailure = RateEngineFailure | Readonly<{
  phase: "PREPARATION";
  code: "LIVE_RATE_PREPARATION_FAILURE";
}>;

export type ScheduledReputationFailure = Readonly<{
  anchorSlug: string;
  code: string;
}>;

export type ScheduledRateSkippedSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  reason: "DUPLICATE_CANDIDATE";
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
    suppressed?: number;
    failures: readonly ScheduledRateFailure[];
    skippedSources: readonly ScheduledRateSkippedSource[];
  }>;
  reputation: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    failures: readonly ScheduledReputationFailure[];
  }>;
}>;
