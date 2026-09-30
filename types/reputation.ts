export type ReputationAnchorStatus = "LIVE" | "DEGRADED" | "DOWN" | "UNKNOWN";
export type ReputationTransferStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "REFUNDED"
  | "EXPIRED"
  | "ERROR";

export type ReputationEvidence = Readonly<{
  anchorId: string;
  anchorSlug: string;
  status: ReputationAnchorStatus;
  corridorSlugs: readonly string[];
  latestRates: readonly Readonly<{
    corridorSlug: string;
    capturedAt: Date | string;
  }>[];
  transferOutcomes: readonly Readonly<{
    status: ReputationTransferStatus;
    settlementMs: number;
    slippage: number;
    recordedAt: Date | string;
  }>[];
}>;

/**
 * PostgreSQL snapshot context (issue #135) describing the single read-only
 * RepeatableRead transaction that observed one evaluation's evidence set.
 * It is deployment/observation metadata for evidence manifests, not evidence
 * about anchors: it proves only that the evidence set was internally coherent
 * at one database point in time.
 */
export const REPUTATION_SNAPSHOT_ISOLATION_LEVEL = "RepeatableRead" as const;
export type ReputationSnapshotIsolationLevel =
  typeof REPUTATION_SNAPSHOT_ISOLATION_LEVEL;

export type ReputationSnapshotContext = Readonly<{
  isolationLevel: ReputationSnapshotIsolationLevel;
  readOnly: true;
  /** PostgreSQL transaction id (xid8) that held the snapshot. */
  transactionId: string;
  /** Transaction start timestamp (transaction_timestamp()) as UTC ISO 8601. */
  snapshotAt: string;
}>;

/** One evaluation's evidence together with the snapshot that observed it. */
export type ReputationEvidenceSet = Readonly<{
  evidence: ReputationEvidence;
  snapshot: ReputationSnapshotContext;
}>;

export type ReputationEvidenceReadFailureCode =
  | "ANCHOR_NOT_FOUND"
  | "SNAPSHOT_UNAVAILABLE"
  | "RETRY_EXHAUSTED";

export type ReputationEvidenceReadResult =
  | Readonly<{ ok: true; evidenceSet: ReputationEvidenceSet }>
  | Readonly<{ ok: false; code: ReputationEvidenceReadFailureCode }>;

export type ReputationComponentName =
  | "availability"
  | "rateFreshness"
  | "coverage"
  | "transferReliability";

export type ReputationComponent = Readonly<{
  weight: number;
  score: number;
  earnedPoints: number;
}>;

export type ReputationCalculation = Readonly<{
  anchorSlug: string;
  computedAt: string;
  state: "insufficient_evidence" | "established";
  score: number | null;
  scoreBand: "GREEN" | "AMBER" | "RED" | null;
  components: Readonly<Record<ReputationComponentName, ReputationComponent>>;
  /** Set by the evaluation engine from the evidence read; null when unset. */
  snapshot: ReputationSnapshotContext | null;
  evidence: Readonly<{
    corridorCount: number;
    latestRateCount: number;
    freshRateCount: number;
    outcomeCount: number;
    completedOutcomeCount: number;
    minimumOutcomeCount: number;
  }>;
  metrics: Readonly<{
    fillRate7d: number | null;
    fillRate30d: number | null;
    fillRate90d: number | null;
    settleP50Ms: number | null;
    settleP95Ms: number | null;
    slippageP50: number | null;
    slippageP95: number | null;
  }>;
}>;

export type PersistedReputationScore = Readonly<{
  id: string;
  anchorSlug: string;
  computedAt: Date;
}>;

export type ReputationPersistenceInput = Readonly<{
  anchorId: string;
  calculation: ReputationCalculation;
}>;

export type ReputationRepository = Readonly<{
  readEvidence: (
    anchorSlug: string,
    outcomeWindowStart: Date,
  ) => Promise<ReputationEvidenceReadResult>;
  upsertScore: (
    input: ReputationPersistenceInput,
  ) => Promise<PersistedReputationScore>;
}>;

export type ReputationEvaluationResult =
  | Readonly<{
      ok: true;
      calculation: ReputationCalculation;
      /** Snapshot that observed this evaluation's evidence set (issue #135). */
      snapshot: ReputationSnapshotContext;
      persisted: PersistedReputationScore | null;
    }>
  | Readonly<{
      ok: false;
      anchorSlug: string;
      code:
        | "ANCHOR_NOT_FOUND"
        | "INVALID_EVALUATION_TIME"
        | "EVIDENCE_READ_FAILURE"
        | "PERSISTENCE_FAILURE";
    }>;
