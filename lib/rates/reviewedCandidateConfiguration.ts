import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";

export type ReviewedCandidateConfiguration = Readonly<{
  candidateCount: number;
  uniqueAnchorCount: number;
}>;

/**
 * Describes reviewed static rate-source configuration for one corridor.
 * This does not make network or database requests and is not runtime evidence.
 */
export function getReviewedCandidateConfiguration(
  corridorSlug: string,
  sources: readonly ReviewedLiveRateSource[] = REVIEWED_LIVE_RATE_SOURCES,
): ReviewedCandidateConfiguration {
  const matchingSources = sources.filter((source) => source.corridorSlug === corridorSlug);
  const uniqueAnchorSlugs = new Set(matchingSources.map(({ anchorSlug }) => anchorSlug));

  return Object.freeze({
    candidateCount: matchingSources.length,
    uniqueAnchorCount: uniqueAnchorSlugs.size,
  });
}
