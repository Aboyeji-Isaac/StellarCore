import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import { getDbForWorkload, SCHEDULED_WORKLOAD } from "@/lib/db/workloadAccessor";
import { PrismaClient } from "@/app/generated/prisma/client";
import type {
  PreparedLiveRateCandidate,
  SafeLiveRateRunSummary,
} from "@/types/liveRateSource";

export type SnapshotReviewedLiveRatesDependencies = Readonly<{
  assertConfiguration: () => void;
  buildCandidates: () => Promise<readonly PreparedLiveRateCandidate[]>;
  executeCandidates: (
    candidates: readonly PreparedLiveRateCandidate[],
    db: PrismaClient,
  ) => Promise<SafeLiveRateRunSummary>;
}>;

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 */
export async function snapshotReviewedLiveRates(
  dependencies: SnapshotReviewedLiveRatesDependencies = DEFAULT_DEPENDENCIES,
): Promise<SafeLiveRateRunSummary> {
  dependencies.assertConfiguration();
  const db = getDbForWorkload(SCHEDULED_WORKLOAD);
  return dependencies.executeCandidates(await dependencies.buildCandidates(), db);
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertConfiguration: assertCurrentStellarCoreConfiguration,
  buildCandidates: buildReviewedLiveRateCandidates,
  executeCandidates: async (candidates, db: PrismaClient) => formatLiveRateRunSummary(
    await runRateEngine(candidates, {
      quote: fetchReviewedIndicativeRate,
      repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
      repositoryDependencies: { db },
    }),
  ),
}) satisfies SnapshotReviewedLiveRatesDependencies;
