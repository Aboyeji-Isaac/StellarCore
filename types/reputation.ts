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
  ) => Promise<ReputationEvidence | null>;
  upsertScore: (
    input: ReputationPersistenceInput,
  ) => Promise<PersistedReputationScore>;
}>;

export type ReputationEvaluationResult =
  | Readonly<{
      ok: true;
      calculation: ReputationCalculation;
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
