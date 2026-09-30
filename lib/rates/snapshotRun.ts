import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import {
  assessCorridorAnomalies,
  type CorridorAnomalyAssessmentSummary,
} from "@/lib/rates/anomalyAssessment";
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
  assessAnomalies?: (
    corridorSlugs: readonly string[],
  ) => Promise<CorridorAnomalyAssessmentSummary>;
}>;

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 */
export async function snapshotReviewedLiveRates(
  dependencies: SnapshotReviewedLiveRatesDependencies = DEFAULT_DEPENDENCIES,
): Promise<SafeLiveRateRunSummary> {
  dependencies.assertConfiguration();

  const suppressed = await (
    dependencies.listSuppressed ??
    (async () => Object.freeze([] as ScheduledSourceIdentity[]))
  )();
  const suppressedKeys = new Set(
    suppressed.map(({ anchorSlug, corridorSlug }) =>
      `${anchorSlug}\0${corridorSlug}`),
  );
  const eligibleSources = REVIEWED_LIVE_RATE_SOURCES.filter(
    ({ anchorSlug, corridorSlug }) =>
      !suppressedKeys.has(`${anchorSlug}\0${corridorSlug}`),
  );

  const candidates = await dependencies.buildCandidates(eligibleSources);
  const summary = await dependencies.executeCandidates(candidates);

  // The anomaly pass runs after persistence, over the corridors that actually
  // received snapshots, so verdicts reflect freshly persisted evidence. It
  // never changes the run's evidence counts; it only appends verdict rows and
  // reports them. A corridors-only pass is skipped: nothing new to assess.
  if (
    !dependencies.assessAnomalies ||
    (summary.snapshots.length === 0 && suppressed.length === 0)
  ) {
    return suppressed.length === 0
      ? summary
      : Object.freeze({
        ...summary,
        totalCandidates: summary.totalCandidates + suppressed.length,
        suppressed: suppressed.length,
      });
  }
  const anomalyAssessment = await dependencies.assessAnomalies(
    summary.snapshots.map(({ corridorSlug }) => corridorSlug),
  );

  return Object.freeze({
    ...summary,
    ...(suppressed.length > 0
      ? {
        totalCandidates: summary.totalCandidates + suppressed.length,
        suppressed: suppressed.length,
      }
      : {}),
    anomalyAssessment,
  });
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
  assessAnomalies: (corridorSlugs) => assessCorridorAnomalies(corridorSlugs),
}) satisfies SnapshotReviewedLiveRatesDependencies;
