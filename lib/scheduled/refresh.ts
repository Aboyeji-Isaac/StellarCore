import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";
import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunSummary,
} from "@/lib/reputation/run";
import { getDbForWorkload, SCHEDULED_WORKLOAD } from "@/lib/db/workloadAccessor";
import { PrismaClient } from "@/app/generated/prisma/client";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { fetchReviewedIndicativeRate } from "@/lib/rates/liveRateSource";
import { formatLiveRateRunSummary } from "@/lib/rates/liveRateSource";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import { buildReviewedLiveRateCandidates } from "@/lib/rates/liveRateSource";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ScheduledRateFailure, ScheduledRefreshResult } from "@/types/scheduled";

export type ScheduledRefreshDependencies = Readonly<{
  snapshotRates: (db: PrismaClient) => Promise<SafeLiveRateRunSummary>;
  evaluateReputation: (options: Readonly<{ evaluatedAt: Date; db: PrismaClient }>) => Promise<ReputationEvaluationRunSummary>;
  now: () => Date;
}>;

/**
 * Executes one scheduler cycle. Rate ingestion intentionally precedes reputation
 * evaluation so the evaluation can use observations written in the same run.
 * A rate preparation failure is isolated; a fatal reputation-run failure reaches
 * the HTTP boundary as a safe 500 response.
 */
export async function runScheduledRefresh(
  dependencies: ScheduledRefreshDependencies = DEFAULT_DEPENDENCIES,
): Promise<ScheduledRefreshResult> {
  const db = getDbForWorkload(SCHEDULED_WORKLOAD);
  const startedAt = dependencies.now();
  let rates: ScheduledRefreshResult["rates"];

  try {
    rates = toScheduledRates(await dependencies.snapshotRates(db));
  } catch {
    rates = preparationFailure();
  }

  const reputation = await dependencies.evaluateReputation({ evaluatedAt: startedAt, db });
  const completedAt = dependencies.now();

  return Object.freeze({
    ok: rates.failed === 0 && reputation.failed === 0,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    rates,
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
  snapshotRates: async () => snapshotReviewedLiveRates({
    assertConfiguration: assertCurrentStellarCoreConfiguration,
    buildCandidates: buildReviewedLiveRateCandidates,
    executeCandidates: async (candidates, db: PrismaClient) => formatLiveRateRunSummary(
      await runRateEngine(candidates, {
        quote: fetchReviewedIndicativeRate,
        repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
        repositoryDependencies: { db },
      }),
    ),
  }),
  evaluateReputation: async ({ evaluatedAt, db }: Readonly<{ evaluatedAt: Date; db: PrismaClient }>) =>
    evaluatePersistedAnchorReputations({ evaluatedAt, db }),
  now: () => new Date(),
}) satisfies ScheduledRefreshDependencies;

function toScheduledRates(summary: SafeLiveRateRunSummary): ScheduledRefreshResult["rates"] {
  return Object.freeze({
    attempted: summary.totalAttempted,
    succeeded: summary.succeeded,
    failed: summary.failed,
    skipped: summary.skipped,
    failures: Object.freeze(summary.failures.map((failure) => Object.freeze({ ...failure }))),
  });
}

function preparationFailure(): ScheduledRefreshResult["rates"] {
  const failure: ScheduledRateFailure = Object.freeze({
    phase: "PREPARATION",
    code: "LIVE_RATE_PREPARATION_FAILURE",
  });
  return Object.freeze({
    attempted: 0,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    failures: Object.freeze([failure]),
  });
}
