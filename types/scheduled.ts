export type ScheduledReputationFailure = Readonly<{
  anchorSlug: string;
  code: string;
}>;

/**
 * Result of the reputation-evaluation job.
 *
 * Reputation evaluation is its own authenticated boundary and its own,
 * slower schedule. It reads persisted evidence only: it never captures a rate,
 * never labels a last known value fresh, and never fabricates an observation or
 * an outcome to cover a capture gap.
 */
export type ScheduledReputationEvaluationResult = Readonly<{
  job: "reputation-evaluation";
  ok: boolean;
  startedAt: string;
  completedAt: string;
  reputation: Readonly<{
    attempted: number;
    succeeded: number;
    failed: number;
    failures: readonly ScheduledReputationFailure[];
  }>;
}>;
