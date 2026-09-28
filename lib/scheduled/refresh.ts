import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunSummary,
} from "@/lib/reputation/run";
import type { ScheduledReputationEvaluationResult } from "@/types/scheduled";

export type ReputationEvaluationDependencies = Readonly<{
  evaluateReputation: (
    options: Readonly<{ evaluatedAt: Date }>,
  ) => Promise<ReputationEvaluationRunSummary>;
  now: () => Date;
}>;

/**
 * Executes one reputation-evaluation cycle over already-persisted evidence.
 *
 * Rate capture is deliberately not part of this job. The capture cadence is
 * bounded by the freshness contract and runs on its own authenticated
 * boundary; reputation evaluation is slower, reads what capture persisted, and
 * must remain correct even when captures are delayed or missed.
 */
export async function runReputationEvaluation(
  dependencies: ReputationEvaluationDependencies = DEFAULT_DEPENDENCIES,
): Promise<ScheduledReputationEvaluationResult> {
  const startedAt = dependencies.now();
  const reputation = await dependencies.evaluateReputation({ evaluatedAt: startedAt });
  const completedAt = dependencies.now();

  return Object.freeze({
    job: "reputation-evaluation" as const,
    ok: reputation.failed === 0,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    reputation: Object.freeze({
      attempted: reputation.attempted,
      succeeded: reputation.succeeded,
      failed: reputation.failed,
      failures: Object.freeze(reputation.failures.map((failure) => Object.freeze({
        anchorSlug: failure.anchorSlug,
        code: failure.code,
      }))),
    }),
  });
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  evaluateReputation: evaluatePersistedAnchorReputations,
  now: () => new Date(),
}) satisfies ReputationEvaluationDependencies;
