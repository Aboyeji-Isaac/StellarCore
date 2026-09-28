import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import { SOURCE_AUTHORITY_REGISTRY } from "@/constants/sourceAuthorities";
import { isValidSourceAuthorityId } from "@/lib/rates/sourceAuthority";
import type { ReviewedLiveRateSource } from "@/types/liveRateSource";
import type { SourceAuthorityRegistryEntry } from "@/types/sourceAuthority";

export type ReviewedCandidateConfiguration = Readonly<{
  candidateCount: number;
  uniqueAnchorCount: number;
  uniqueAuthorityCount: number;
}>;

/**
 * Describes reviewed static rate-source configuration for one corridor.
 * This does not make network or database requests and is not runtime evidence.
 * `uniqueAuthorityCount` counts reviewed authority identities, not anchor
 * slugs: differently named anchors under one operator remain one authority.
 */
export function getReviewedCandidateConfiguration(
  corridorSlug: string,
  sources: readonly ReviewedLiveRateSource[] = REVIEWED_LIVE_RATE_SOURCES,
): ReviewedCandidateConfiguration {
  const matchingSources = sources.filter((source) => source.corridorSlug === corridorSlug);
  const uniqueAnchorSlugs = new Set(matchingSources.map(({ anchorSlug }) => anchorSlug));
  const uniqueAuthorityIds = new Set(
    matchingSources.map(({ authorityId }) => authorityId),
  );

  return Object.freeze({
    candidateCount: matchingSources.length,
    uniqueAnchorCount: uniqueAnchorSlugs.size,
    uniqueAuthorityCount: uniqueAuthorityIds.size,
  });
}

/**
 * Resolves the reviewed display label for a persisted authority id. This is
 * presentation metadata only: neither a rename nor removing the authority from
 * current configuration changes the persisted identity, its configuration
 * version, or how many independent authorities an observation set contains.
 */
export function getReviewedAuthorityDisplayName(
  authorityId: string | null,
  authorities: readonly SourceAuthorityRegistryEntry[] = SOURCE_AUTHORITY_REGISTRY,
): string | null {
  if (!isValidSourceAuthorityId(authorityId)) return null;
  const authority = authorities.find((entry) => entry.authorityId === authorityId);
  return authority ? authority.displayName : null;
}
