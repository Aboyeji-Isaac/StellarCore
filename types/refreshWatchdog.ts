/** Outcome of one completed scheduled refresh run (issue #189). */
export type RefreshRunOutcome = "successful" | "partial" | "failed";

/** The latest run as seen by the watchdog. "none" means no run was ever recorded. */
export type RefreshLatestRunState = RefreshRunOutcome | "none" | "in_progress";

/**
 * Minimal durable heartbeat state, one row per pipeline. It is not a run
 * ledger: #111 owns per-run history, locking, and resumption.
 */
export type RefreshWatchdogState = Readonly<{
  pipeline: string;
  /** When the watchdog began tracking; the no-run baseline. */
  trackingSince: Date;
  lastRunId: string | null;
  lastRunStartedAt: Date | null;
  lastRunCompletedAt: Date | null;
  lastRunOutcome: RefreshRunOutcome | null;
  lastRunFailureCode: string | null;
  /** Advances only when a run completes successfully; never moves backwards. */
  lastSuccessfulRefreshAt: Date | null;
  consecutiveUnsuccessfulRuns: number;
}>;

export type RefreshWatchdogRepository = Readonly<{
  read: (pipeline: string) => Promise<RefreshWatchdogState | null>;
  /**
   * Atomically reads the current state (null if absent), applies the pure
   * transition, and persists the result.
   */
  transition: (
    pipeline: string,
    apply: (current: RefreshWatchdogState | null) => RefreshWatchdogState,
  ) => Promise<RefreshWatchdogState>;
}>;

export type RefreshFreshnessState =
  | "fresh"
  | "degraded"
  | "awaiting_first_refresh"
  | "stale";

export type RefreshStaleReason =
  | "no_successful_refresh"
  | "missed_expected_refresh"
  | "no_watchdog_state";

export type RefreshWatchdogStatus = Readonly<{
  pipeline: string;
  evaluatedAt: string;
  state: RefreshFreshnessState;
  staleReason: RefreshStaleReason | null;
  lastSuccessfulRefreshAt: string | null;
  expectedRefreshAt: string | null;
  staleAt: string | null;
  cadenceMs: number;
  graceMs: number;
  consecutiveUnsuccessfulRuns: number;
  latestRun: Readonly<{
    state: RefreshLatestRunState;
    startedAt: string | null;
    completedAt: string | null;
    failureCode: string | null;
  }>;
}>;
