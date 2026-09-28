import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import type {
  PreparedLiveRateCandidate,
  SafeLiveRateRunSummary,
} from "@/types/liveRateSource";
import type { RateSnapshotLineage } from "@/types/rates";

/**
 * Per-invocation knobs for the shared boundary. The CLI leaves `lineage` unset
 * because a manual snapshot is not a scheduled capture; the authenticated
 * capture boundary always supplies one.
 */
export type SnapshotReviewedLiveRatesOptions = Readonly<{
  lineage?: RateSnapshotLineage;
  shouldContinue?: () => boolean;
  now?: () => Date;
}>;

export type SnapshotReviewedLiveRatesDependencies = Readonly<{
  assertConfiguration: () => void;
  buildCandidates: () => Promise<readonly PreparedLiveRateCandidate[]>;
  executeCandidates: (
    candidates: readonly PreparedLiveRateCandidate[],
    options: SnapshotReviewedLiveRatesOptions,
  ) => Promise<SafeLiveRateRunSummary>;
}>;

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 */
export async function snapshotReviewedLiveRates(
  dependencies: SnapshotReviewedLiveRatesDependencies = DEFAULT_DEPENDENCIES,
  options: SnapshotReviewedLiveRatesOptions = {},
): Promise<SafeLiveRateRunSummary> {
  dependencies.assertConfiguration();
  return dependencies.executeCandidates(await dependencies.buildCandidates(), options);
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertConfiguration: assertCurrentStellarCoreConfiguration,
  buildCandidates: buildReviewedLiveRateCandidates,
  executeCandidates: async (candidates, options) => formatLiveRateRunSummary(
    await runRateEngine(candidates, {
      quote: fetchReviewedIndicativeRate,
      repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
      ...(options.lineage ? { lineage: options.lineage } : {}),
      ...(options.shouldContinue ? { shouldContinue: options.shouldContinue } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  ),
}) satisfies SnapshotReviewedLiveRatesDependencies;
