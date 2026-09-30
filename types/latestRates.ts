import type {
  MedianExclusionReason,
  RateAnomalyReason,
  RateAnomalyStatus,
  RateFreshnessState,
} from "@/types/rates";

/** The newest persisted anomaly verdict for one snapshot (issue #186). */
export type PersistedRateAnomalyVerdict = Readonly<{
  status: RateAnomalyStatus;
  reason: RateAnomalyReason | null;
}>;

/**
 * The anomaly verdict the read model applied. "persisted" is the newest
 * append-only assessment row; "evaluated" means no row existed yet and the
 * identical deterministic criterion was applied at read time, so an
 * unassessed snapshot can never bypass the anomaly gate.
 */
export type AppliedRateAnomalyVerdict = PersistedRateAnomalyVerdict & Readonly<{
  origin: "persisted" | "evaluated";
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
  anomaly?: PersistedRateAnomalyVerdict | null;
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
  /** Internal diagnostics only; never serialized by the public rates API. */
  anomaly: AppliedRateAnomalyVerdict;
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
      code: "CORRIDOR_NOT_FOUND" | "INVALID_EVALUATION_TIME" | "READ_FAILURE" | "DATABASE_UNAVAILABLE";
    }>;
