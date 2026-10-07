import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import { PRISMA_SUPPRESSION_REPOSITORY } from "@/lib/scheduled/suppressionRepository";
import type {
  PreparedLiveRateCandidate,
  ReviewedLiveRateSource,
  SafeLiveRateRunSummary,
} from "@/types/liveRateSource";
import type { ScheduledSourceIdentity } from "@/types/suppression";

export type SnapshotReviewedLiveRatesDependencies = Readonly<{
  assertConfiguration: () => void;
  buildCandidates: (
    sources?: readonly ReviewedLiveRateSource[],
  ) => Promise<readonly PreparedLiveRateCandidate[]>;
  listSuppressed?: () => Promise<readonly ScheduledSourceIdentity[]>;
  executeCandidates: (
    candidates: readonly PreparedLiveRateCandidate[],
  ) => Promise<SafeLiveRateRunSummary>;
  listSuppressions: () => Promise<readonly Readonly<{ anchorSlug: string; corridorSlug: string }>[]>;
}>;

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 *
 * Durably suppressed sources are excluded before candidates are executed so
 * they never consume scheduler capacity and never count toward freshness.
 */
export async function snapshotReviewedLiveRates(
  dependencies: SnapshotReviewedLiveRatesDependencies = DEFAULT_DEPENDENCIES,
): Promise<SafeLiveRateRunSummary> {
  dependencies.assertConfiguration();
const [suppressions, candidates] = await Promise.all([
    dependencies.listSuppressions(),
    dependencies.buildCandidates(),
  ]);

  const suppressedKeys = new Set(
    suppressions.map((suppression) => `${suppression.anchorSlug}:${suppression.corridorSlug}`),
  );
  const eligible = candidates.filter(
    (candidate) => !suppressedKeys.has(`${candidate.anchorSlug}:${candidate.corridorSlug}`),
  );
  const suppressed = candidates.length - eligible.length;

  const summary = await dependencies.executeCandidates(eligible);
  if (suppressed === 0) return summary;
  return Object.freeze({ ...summary, suppressed });
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  assertConfiguration: assertCurrentStellarCoreConfiguration,
  buildCandidates: buildReviewedLiveRateCandidates,
  listSuppressed: PRISMA_SUPPRESSION_REPOSITORY.listSuppressed,
  executeCandidates: async (candidates) => formatLiveRateRunSummary(
    await runRateEngine(candidates, {
      quote: fetchReviewedIndicativeRate,
      repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
    }),
  ),
  listSuppressions: async () => {
    const active = await PRISMA_SUPPRESSION_REPOSITORY.listActive();
    return Object.freeze(active.map((suppression) => Object.freeze({
      anchorSlug: suppression.anchorSlug,
      corridorSlug: suppression.corridorSlug,
    })));
  },
}) satisfies SnapshotReviewedLiveRatesDependencies;
