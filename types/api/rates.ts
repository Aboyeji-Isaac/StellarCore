import type { MedianExclusionReason, RateFreshnessState } from "@/types/rates";

export type PublicRateObservation = Readonly<{
  anchor: Readonly<{
    slug: string;
    name: string;
  }>;
  /**
   * Reviewed authority persisted with the observation. `id` is `null` when the
   * authority is unknown, which is how legacy snapshots are migrated. The
   * display name is resolved from currently reviewed configuration and is
   * annotated as metadata only; it never changes authority identity.
   */
  authority: Readonly<{
    id: string | null;
    displayName: string | null;
    configurationVersion: number | null;
  }>;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: string;
  freshness: Readonly<{
    state: RateFreshnessState;
    ageMs: number | null;
  }>;
  eligibleForMedian: boolean;
  exclusionReason?: MedianExclusionReason;
}>;

export type PublicReviewedCandidateConfiguration = Readonly<{
  candidateCount: number;
  uniqueAnchorCount: number;
  uniqueAuthorityCount: number;
}>;

export type PublicMedianRequirement = Readonly<{
  minimumFreshIndependentSources: number;
}>;

export type PublicRatesResponse = Readonly<{
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>;
  evaluatedAt: string;
  state: "healthy" | "insufficient_fresh_sources";
  medianRate: string | null;
  /** Latest persisted observations for the corridor. */
  sourceCount: number;
  /** Fresh eligible independent sources after the authority collapse. */
  freshSourceCount: number;
  /** Explicit restatement of `sourceCount` for evidence transparency. */
  totalObservationCount: number;
  /** Observations inside the freshness window before correlation collapse. */
  freshObservationCount: number;
  /** Distinct reviewed authorities behind those observations. */
  independentAuthorityCount: number;
  reviewedCandidateConfiguration: PublicReviewedCandidateConfiguration;
  medianRequirement: PublicMedianRequirement;
  observations: readonly PublicRateObservation[];
}>;

export type RatesApiErrorCode =
  | "missing_corridor"
  | "invalid_corridor"
  | "corridor_not_found"
  | "internal_error";

export type RatesApiErrorResponse = Readonly<{
  error: Readonly<{
    code: RatesApiErrorCode;
    message: string;
  }>;
}>;

export type RatesApiResult =
  | Readonly<{ status: 200; body: PublicRatesResponse }>
  | Readonly<{ status: 400 | 404 | 500; body: RatesApiErrorResponse }>;
