export const EVIDENCE_EXPORT_VERSION = "1.0" as const;
export type EvidenceExportVersion = typeof EVIDENCE_EXPORT_VERSION;

export const EVIDENCE_MEMBER_PATHS = Object.freeze([
  "registry.json",
  "rate-snapshots.ndjson",
  "transfer-outcomes.ndjson",
  "reputation-scores.ndjson",
] as const);
export type EvidenceMemberPath = (typeof EVIDENCE_MEMBER_PATHS)[number];

export type ExportSelection = Readonly<{
  timeRange: Readonly<{ start: string; end: string }>;
  anchorSlugs?: readonly string[];
  corridorSlugs?: readonly string[];
}>;

export type ExportProvenance = Readonly<{
  exportedAt: string;
  exportedBy: string;
  stellarCoreVersion: string;
  schemaVersion: EvidenceExportVersion;
  selection: ExportSelection;
  deploymentRevision?: string;
  configurationFingerprint?: string;
}>;

export type ExportManifestEntry = Readonly<{
  path: EvidenceMemberPath;
  sha256: string;
  byteLength: number;
  recordCount: number;
}>;

export type ExportManifest = Readonly<{
  version: EvidenceExportVersion;
  provenance: ExportProvenance;
  members: readonly ExportManifestEntry[];
  rootSha256: string;
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

export type ExportRegistry = Readonly<{
  anchors: readonly ExportAnchor[];
  corridors: readonly ExportCorridor[];
  anchorCorridors: readonly ExportAnchorCorridor[];
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

export type ExportDependencies = Readonly<{
  queryRegistry: (selection: ExportSelection) => Promise<ExportRegistry>;
  streamRateSnapshots: (
    selection: ExportSelection,
  ) => AsyncIterable<ExportRateSnapshot>;
  streamTransferOutcomes: (
    selection: ExportSelection,
  ) => AsyncIterable<ExportTransferOutcome>;
  streamReputationScores: (
    selection: ExportSelection,
  ) => AsyncIterable<ExportReputationScore>;
}>;

export type ExportResult =
  | Readonly<{ ok: true; outputPath: string; manifest: ExportManifest }>
  | Readonly<{
      ok: false;
      code:
        | "INVALID_SELECTION"
        | "DATABASE_ERROR"
        | "IO_ERROR"
        | "SECRET_DETECTED";
      message: string;
    }>;

export type VerificationResult =
  | Readonly<{ ok: true; manifest: ExportManifest }>
  | Readonly<{
      ok: false;
      code:
        | "MISSING_MEMBER"
        | "CORRUPTED_DATA"
        | "INVALID_SCHEMA"
        | "UNSUPPORTED_VERSION"
        | "SECRET_DETECTED";
      message: string;
    }>;
