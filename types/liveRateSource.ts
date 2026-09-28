import type { RateCandidate, RateEngineResult } from "@/types/rates";
import type { Sep38AssetIdentifier } from "@/types/sep38";

export type ReviewedLiveRateSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  /**
   * Reviewed source-authority id from `SOURCE_AUTHORITY_REGISTRY`. It is
   * separate from the anchor slug and endpoint hostname so commonly controlled
   * or upstream-dependent observations cannot be presented as independent.
   */
  authorityId: string;
  sellAsset: Sep38AssetIdentifier;
  buyAsset: Sep38AssetIdentifier;
  sellAmount: string;
  buyDeliveryMethod?: string;
  countryCode?: string;
  context: "sep6" | "sep31";
}>;

export type PreparedLiveRateCandidate = RateCandidate & Readonly<{
  quoteServer: string;
}>;

export type SafeLiveRateRunSummary = Readonly<{
  totalCandidates: number;
  totalAttempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  snapshotsPersisted: number;
  snapshots: readonly Readonly<{
    id: string;
    anchorSlug: string;
    corridorSlug: string;
    authorityId: string;
    authorityConfigurationVersion: number;
    rate: string;
    capturedAt: string;
  }>[];
  failures: RateEngineResult["failures"];
  skippedSources: RateEngineResult["skippedSources"];
}>;
