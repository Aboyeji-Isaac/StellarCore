import type { MedianExclusionReason, RateFreshnessState } from "@/types/rates";

export type LatestRateRepositoryCorridor = Readonly<{
  id: string;
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
}>;

export type LatestRateRepositoryObservation = Readonly<{
  id: string;
  anchorSlug: string;
  anchorName: string;
  /**
   * Reviewed authority persisted with the observation. `null` means the
   * authority is unknown, which is how legacy snapshots are migrated: the
   * reviewed mapping is never reconstructed from current configuration.
   */
  authorityId: string | null;
  authorityConfigurationVersion: number | null;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date | string;
}>;

export type LatestRateRepository = Readonly<{
  findCorridorBySlug: (
    slug: string,
  ) => Promise<LatestRateRepositoryCorridor | null>;
  findLatestObservations: (
    corridorId: string,
  ) => Promise<readonly LatestRateRepositoryObservation[]>;
}>;

export type LatestRateSourceObservation = Readonly<{
  snapshotId: string;
  anchorSlug: string;
  anchorName: string;
  authorityId: string | null;
  authorityConfigurationVersion: number | null;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: string;
  freshnessState: RateFreshnessState;
  ageMs: number | null;
  included: boolean;
  exclusionReason?: MedianExclusionReason;
}>;

export type LatestCorridorRate = Readonly<{
  ok: true;
  corridor: Readonly<{
    slug: string;
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
  }>;
  evaluatedAt: string;
  state: "healthy" | "insufficient_fresh_sources";
  median: string | null;
  /** Every latest persisted observation for the corridor. */
  totalObservationCount: number;
  /** Observations inside the freshness window, before correlation collapse. */
  freshObservationCount: number;
  /** Distinct reviewed authorities represented by the observations. */
  independentAuthorityCount: number;
  /** Fresh eligible observations after at most one per authority. */
  freshIndependentSourceCount: number;
  observations: readonly LatestRateSourceObservation[];
  exclusions: readonly LatestRateSourceObservation[];
}>;

export type LatestCorridorRateReadResult =
  | LatestCorridorRate
  | Readonly<{
      ok: false;
      corridorSlug: string;
      code: "CORRIDOR_NOT_FOUND" | "INVALID_EVALUATION_TIME" | "READ_FAILURE";
    }>;
