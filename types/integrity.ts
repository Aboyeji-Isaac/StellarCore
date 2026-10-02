import type { ReputationAnchorStatus } from "@/types/reputation";

/**
 * Entity classes the integrity audit can report against. These are the
 * persisted evidence-graph tables owned by StellarCore, not registry inputs.
 */
export type EvidenceIntegrityEntityType =
  | "anchor"
  | "corridor"
  | "anchor_corridor"
  | "rate_snapshot"
  | "transfer_outcome"
  | "reputation_score";

export type EvidenceIntegrityTransferStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "REFUNDED"
  | "EXPIRED"
  | "ERROR";

export type EvidenceIntegrityScoreBand = "GREEN" | "AMBER" | "RED";

export type EvidenceIntegrityReputationState = "INSUFFICIENT_DATA" | "OK";

/**
 * Cross-table invariants that the PostgreSQL schema cannot express as simple
 * constraints. The set is closed and intentionally small; every code has a
 * documented remediation and a seeded integration fixture.
 */
export type EvidenceIntegrityViolationCode =
  // Anchor/corridor relationship drift.
  | "RATE_SNAPSHOT_MEMBERSHIP_MISSING"
  | "TRANSFER_OUTCOME_MEMBERSHIP_MISSING"
  | "DUPLICATE_CORRIDOR_SEMANTIC_IDENTITY"
  // Incompatible timestamps.
  | "RATE_SNAPSHOT_TIMESTAMP_FUTURE"
  | "RATE_SNAPSHOT_TIMESTAMP_BEFORE_ANCHOR"
  | "TRANSFER_OUTCOME_TIMESTAMP_FUTURE"
  | "TRANSFER_OUTCOME_TIMESTAMP_BEFORE_ANCHOR"
  | "REPUTATION_SCORE_TIMESTAMP_FUTURE"
  | "REPUTATION_SCORE_TIMESTAMP_BEFORE_ANCHOR"
  // Invalid score/evidence combinations.
  | "REPUTATION_STATE_OK_WITH_INSUFFICIENT_SAMPLE"
  | "REPUTATION_STATE_OK_WITHOUT_COMPOSITE_SCORE"
  | "REPUTATION_STATE_OK_WITHOUT_SCORE_BAND"
  | "REPUTATION_INSUFFICIENT_DATA_WITH_SCORE"
  | "REPUTATION_COMPOSITE_SCORE_OUT_OF_RANGE"
  | "REPUTATION_SCORE_BAND_MISMATCH"
  | "REPUTATION_SAMPLE_SIZE_NEGATIVE"
  | "REPUTATION_FILL_RATE_OUT_OF_RANGE"
  | "REPUTATION_PERCENTILE_ORDER"
  | "REPUTATION_DURATION_NEGATIVE"
  // Invalid persisted evidence values.
  | "RATE_SNAPSHOT_NON_POSITIVE_AMOUNT"
  | "RATE_SNAPSHOT_NEGATIVE_FEE"
  | "TRANSFER_OUTCOME_INVALID_METRIC"
  | "TRANSFER_OUTCOME_NEGATIVE_SETTLEMENT"
  | "TRANSFER_OUTCOME_FILL_RATE_OUT_OF_RANGE";

export type EvidenceIntegrityFinding = Readonly<{
  code: EvidenceIntegrityViolationCode;
  entity: Readonly<{
    type: EvidenceIntegrityEntityType;
    id: string;
  }>;
  anchorSlug?: string;
  corridorSlug?: string;
  remediation: string;
}>;

export type EvidenceIntegrityAuditCounts = Readonly<{
  anchors: number;
  corridors: number;
  anchorCorridors: number;
  rateSnapshots: number;
  transferOutcomes: number;
  reputationScores: number;
}>;

/**
 * Bounded, deterministic audit output. `findingCount` is the true number of
 * detected violations; `findings` is capped for safe CI/operator logging and
 * `suppressedFindingCount` reports how many were omitted.
 */
export type EvidenceIntegrityAuditReport = Readonly<{
  ok: true;
  generatedAt: string;
  counts: EvidenceIntegrityAuditCounts;
  truncated: boolean;
  findingCount: number;
  suppressedFindingCount: number;
  findings: readonly EvidenceIntegrityFinding[];
  remediationCatalog: readonly Readonly<{
    code: EvidenceIntegrityViolationCode;
    guidance: string;
  }>[];
}>;

// --- Read-only snapshot row shapes -----------------------------------------

export type EvidenceIntegrityAnchorRow = Readonly<{
  id: string;
  slug: string;
  status: ReputationAnchorStatus;
  createdAt: Date;
}>;

export type EvidenceIntegrityCorridorRow = Readonly<{
  id: string;
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
}>;

export type EvidenceIntegrityMembershipRow = Readonly<{
  anchorId: string;
  corridorId: string;
}>;

export type EvidenceIntegrityRateSnapshotRow = Readonly<{
  id: string;
  anchorId: string;
  corridorId: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

export type EvidenceIntegrityTransferOutcomeRow = Readonly<{
  id: string;
  anchorId: string;
  corridorId: string;
  status: EvidenceIntegrityTransferStatus;
  fillRate: number;
  settlementMs: number;
  slippage: number;
  recordedAt: Date;
}>;

export type EvidenceIntegrityReputationScoreRow = Readonly<{
  id: string;
  anchorId: string;
  compositeScore: number | null;
  scoreBand: EvidenceIntegrityScoreBand | null;
  fillRate7d: number | null;
  fillRate30d: number | null;
  fillRate90d: number | null;
  settleP50Ms: number | null;
  settleP95Ms: number | null;
  slippageP50: number | null;
  slippageP95: number | null;
  sampleSize: number;
  state: EvidenceIntegrityReputationState;
  computedAt: Date;
}>;

export type EvidenceIntegrityAuditSnapshot = Readonly<{
  anchors: readonly EvidenceIntegrityAnchorRow[];
  corridors: readonly EvidenceIntegrityCorridorRow[];
  anchorCorridors: readonly EvidenceIntegrityMembershipRow[];
  rateSnapshots: readonly EvidenceIntegrityRateSnapshotRow[];
  transferOutcomes: readonly EvidenceIntegrityTransferOutcomeRow[];
  reputationScores: readonly EvidenceIntegrityReputationScoreRow[];
}>;

export type EvidenceIntegrityAuditReadResult = Readonly<{
  snapshot: EvidenceIntegrityAuditSnapshot;
  truncated: boolean;
}>;

export type EvidenceIntegrityAuditLimits = Readonly<{
  maxRowsPerHighVolumeTable: number;
  maxFindingsPerCode: number;
  maxFindings: number;
  futureTimestampToleranceMs: number;
}>;

/**
 * The only I/O the audit performs: one bounded, read-only snapshot read. The
 * audit never receives a writer, a transaction, or a mutation callback.
 */
export type EvidenceIntegrityAuditDependencies = Readonly<{
  readSnapshot: (
    limits: EvidenceIntegrityAuditLimits,
  ) => Promise<EvidenceIntegrityAuditReadResult>;
}>;

export type EvidenceIntegrityAuditFailureCode =
  | "INVALID_AUDIT_TIME"
  | "SNAPSHOT_READ_FAILURE";

/**
 * Safe failure result. It carries no database, environment, or driver detail
 * so it can be logged or returned from a CI/operator boundary unchanged.
 */
export type EvidenceIntegrityAuditFailure = Readonly<{
  ok: false;
  code: EvidenceIntegrityAuditFailureCode;
}>;

export type EvidenceIntegrityAuditResult =
  | EvidenceIntegrityAuditReport
  | EvidenceIntegrityAuditFailure;

export type EvidenceIntegrityAuditOptions = Readonly<{
  dependencies?: EvidenceIntegrityAuditDependencies;
  limits?: EvidenceIntegrityAuditLimits;
  observedAt?: Date;
}>;
