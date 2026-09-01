import {
  buildReviewedLiveRateCandidates,
  fetchReviewedIndicativeRate,
  formatLiveRateRunSummary,
} from "@/lib/rates/liveRateSource";
import { runRateEngine } from "@/lib/rates/rateEngine";
import { PRISMA_RATE_SNAPSHOT_REPOSITORY } from "@/lib/rates/snapshot";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

/**
 * Runs the reviewed production rate-source boundary once. This is intentionally
 * shared by the CLI and the authenticated scheduler so they cannot drift.
 */
export async function snapshotReviewedLiveRates(): Promise<SafeLiveRateRunSummary> {
  const candidates = await buildReviewedLiveRateCandidates();
  const result = await runRateEngine(candidates, {
    quote: fetchReviewedIndicativeRate,
    repository: PRISMA_RATE_SNAPSHOT_REPOSITORY,
  });
  return formatLiveRateRunSummary(result);
}
