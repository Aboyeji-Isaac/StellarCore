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
  totalIndependentSources: number;
  freshSourceCount: number;
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
