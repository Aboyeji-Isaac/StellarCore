export type ExportVersion = "1.0";

export type ExportSelection = Readonly<{
  timeRange: Readonly<{
    start: string;
    end: string;
  }>;
  anchorSlugs?: readonly string[];
  corridorSlugs?: readonly string[];
}>;

export type ExportProvenance = Readonly<{
  exportedAt: string;
  exportedBy: string;
  stellarCoreVersion: string;
  schemaVersion: ExportVersion;
  selection: ExportSelection;
}>;

export type ExportAnchor = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  status: string;
  seps: readonly number[];
  isTransferCapable: boolean;
  createdAt: string;
  updatedAt: string;
}>;

export type ExportCorridor = Readonly<{
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
}>;

export type ExportAnchorCorridor = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
}>;

export type ExportRateSnapshot = Readonly<{
  id: string;
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: string;
}>;

export type ExportTransferOutcome = Readonly<{
  id: string;
  anchorSlug: string;
  corridorSlug: string;
  status: string;
  fillRate: number;
  settlementMs: number;
  slippage: number;
  recordedAt: string;
}>;

export type ExportReputationScore = Readonly<{
  id: string;
  anchorSlug: string;
  compositeScore: number | null;
  scoreBand: string | null;
  fillRate7d: number | null;
  fillRate30d: number | null;
  fillRate90d: number | null;
  settleP50Ms: number | null;
  settleP95Ms: number | null;
  slippageP50: number | null;
  slippageP95: number | null;
  sampleSize: number;
  state: string;
  computedAt: string;
}>;

export type ExportRegistry = Readonly<{
  anchors: readonly ExportAnchor[];
  corridors: readonly ExportCorridor[];
  anchorCorridors: readonly ExportAnchorCorridor[];
}>;

export type ExportEvidence = Readonly<{
  rateSnapshots: readonly ExportRateSnapshot[];
  transferOutcomes: readonly ExportTransferOutcome[];
  reputationScores: readonly ExportReputationScore[];
}>;

export type ExportManifestEntry = Readonly<{
  path: string;
  sha256: string;
  byteLength: number;
  recordCount: number;
}>;

export type ExportManifest = Readonly<{
  version: ExportVersion;
  provenance: ExportProvenance;
  registry: ExportManifestEntry;
  evidence: ExportManifestEntry;
  rootSha256: string;
}>;

export type ExportPackage = Readonly<{
  manifest: ExportManifest;
  registry: ExportRegistry;
  evidence: ExportEvidence;
}>;

export type VerificationResult =
  | Readonly<{
      ok: true;
      manifest: ExportManifest;
    }>
  | Readonly<{
      ok: false;
      code: "MANIFEST_MISMATCH" | "MISSING_MEMBER" | "CORRUPTED_DATA" | "INVALID_SCHEMA" | "SECRET_DETECTED";
      message: string;
      details?: Readonly<Record<string, unknown>>;
    }>;

export type ExportErrorCode =
  | "INVALID_SELECTION"
  | "DATABASE_ERROR"
  | "SERIALIZATION_ERROR"
  | "MANIFEST_GENERATION_ERROR"
  | "IO_ERROR"
  | "SECRET_REDACTION_ERROR";

export type ExportResult =
  | Readonly<{
      ok: true;
      manifest: ExportManifest;
      outputPath: string;
    }>
  | Readonly<{
      ok: false;
      code: ExportErrorCode;
      message: string;
    }>;