import type { MedianExclusionReason, RateFreshnessState } from "@/types/rates";

export type PublicRateObservation = Readonly<{
  anchor: Readonly<{
    slug: string;
    name: string;
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
  sourceCount: number;
  freshSourceCount: number;
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
