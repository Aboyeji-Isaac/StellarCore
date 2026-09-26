export type RateHistoryRepositoryCorridor = Readonly<{
  id: string;
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
}>;

export type RateHistoryRepositoryObservation = Readonly<{
  id: string;
  anchorSlug: string;
  anchorName: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date | string;
}>;

export type RateHistoryRepository = Readonly<{
  findCorridorBySlug: (
    slug: string,
  ) => Promise<RateHistoryRepositoryCorridor | null>;
  findHistoryObservations: (
    corridorId: string,
    fromDate: Date,
    toDate: Date,
  ) => Promise<readonly RateHistoryRepositoryObservation[]>;
}>;

export type RateHistoryObservation = Readonly<{
  anchorSlug: string;
  anchorName: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: string;
}>;

export type CorridorRateHistoryPoint = Readonly<{
  timestamp: string;
  medianRate: string | null;
  state: "healthy" | "insufficient_fresh_sources";
  sourceCount: number;
  freshSourceCount: number;
  observations: readonly RateHistoryObservation[];
}>;

export type CorridorRateHistory = Readonly<{
  ok: true;
  corridor: Readonly<{
    slug: string;
    sourceAsset: string;
    sourceCountry: string;
    destinationAsset: string;
    destinationCountry: string;
  }>;
  evaluatedAt: string;
  windowDays: number;
  points: readonly CorridorRateHistoryPoint[];
}>;

export type CorridorRateHistoryReadResult =
  | CorridorRateHistory
  | Readonly<{
      ok: false;
      corridorSlug: string;
      code:
        | "CORRIDOR_NOT_FOUND"
        | "INVALID_EVALUATION_TIME"
        | "INVALID_WINDOW"
        | "READ_FAILURE";
    }>;
