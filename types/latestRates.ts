import type {
  BlockingDispositionState,
  MedianExclusionReason,
  RateFreshnessState,
} from "@/types/rates";

/**
 * The current blocking disposition of an observation. Absent means the
 * observation is usable: either never reviewed or released from quarantine.
 */
export type ObservationDisposition = Readonly<{
  state: BlockingDispositionState;
  reasonCode: string;
  recordedAt: string;
}>;

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
  disposition?: ObservationDisposition | null;
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
  disposition?: ObservationDisposition;
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
