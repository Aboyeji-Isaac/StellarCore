export type ReputationAnchorStatus = "LIVE" | "DEGRADED" | "DOWN" | "UNKNOWN";
export type ReputationTransferStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "REFUNDED"
  | "EXPIRED"
  | "ERROR";

export type ReputationCorridorEvidence = Readonly<{
  corridorId: string;
  slug: string;
}>;

export type ReputationRateEvidence = Readonly<{
  rateSnapshotId: string;
  corridorId: string;
  corridorSlug: string;
  capturedAt: Date | string;
}>;

export type ReputationOutcomeEvidence = Readonly<{
  transferOutcomeId: string;
  corridorId: string;
  status: ReputationTransferStatus;
  settlementMs: number;
  slippage: number;
  recordedAt: Date | string;
}>;

/**
 * The exact persisted evidence read for one evaluation. Stable persisted IDs
 * are carried alongside the scoring values so an immutable evidence-set
 * manifest can name the rows that were actually considered rather than
 * reconstructing membership from later database state.
 */
export type ReputationEvidence = Readonly<{
  anchorId: string;
  anchorSlug: string;
  status: ReputationAnchorStatus;
  corridors: readonly ReputationCorridorEvidence[];
  latestRates: readonly ReputationRateEvidence[];
  transferOutcomes: readonly ReputationOutcomeEvidence[];
  /**
   * Count of persisted outcomes for this anchor older than the evaluation's
   * outcome window. Recorded as a bounded count only: the individual rows were
   * not read and are never named as members.
   */
  outsideOutcomeCount: number;
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
  manifestId: string | null;
  manifestSchemaVersion: number | null;
}>;

export type ReputationPersistenceInput = Readonly<{
  anchorId: string;
  evaluatedAt: Date;
  outcomeWindowStart: Date;
  evidence: ReputationEvidence;
  calculation: ReputationCalculation;
}>;

export type ReputationEvidenceEligibilityValue =
  | "ELIGIBLE"
  | "EXCLUDED"
  | "OUTSIDE_WINDOW";

export type ReputationEvidenceReasonCodeValue =
  | "NONE"
  | "STALE_RATE"
  | "FUTURE_TIMESTAMP"
  | "INVALID_TIMESTAMP"
  | "OUTSIDE_OUTCOME_WINDOW"
  | "INVALIDATED_OBSERVATION"
  | "UNKNOWN_AUTHORITY"
  | "RETIRED_OR_NON_MEMBER";

export type ReputationCorridorMembershipValue =
  | "MEMBER"
  | "RETIRED"
  | "NON_MEMBER";

export type ReputationCorridorMemberDraft = Readonly<{
  corridorId: string;
  membership: ReputationCorridorMembershipValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

export type ReputationRateMemberDraft = Readonly<{
  rateSnapshotId: string;
  corridorId: string;
  capturedAt: Date;
  ageMs: number | null;
  eligibility: ReputationEvidenceEligibilityValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

export type ReputationOutcomeMemberDraft = Readonly<{
  transferOutcomeId: string;
  corridorId: string;
  status: ReputationTransferStatus;
  recordedAt: Date;
  eligibility: ReputationEvidenceEligibilityValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

/**
 * A pure, deterministic description of one immutable evidence-set manifest.
 * Building it performs no I/O and never copies raw remote responses, secrets,
 * or mutable display text — only stable IDs and bounded classification.
 */
export type ReputationEvidenceManifestDraft = Readonly<{
  manifestSchemaVersion: number;
  reasonCodeVocabularyVersion: number;
  scoringPolicyVersion: string;
  freshnessPolicyVersion: string;
  configurationRevision: string;
  anchorId: string;
  anchorStatus: ReputationAnchorStatus;
  evaluatedAt: Date;
  outcomeWindowStart: Date;
  corridorCount: number;
  latestRateCount: number;
  freshRateCount: number;
  outcomeCount: number;
  completedOutcomeCount: number;
  outsideOutcomeCount: number;
  minimumOutcomeCount: number;
  corridorMembers: readonly ReputationCorridorMemberDraft[];
  rateMembers: readonly ReputationRateMemberDraft[];
  outcomeMembers: readonly ReputationOutcomeMemberDraft[];
}>;

export type ReputationManifestCorridorMember = Readonly<{
  corridorId: string;
  membership: ReputationCorridorMembershipValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

export type ReputationManifestRateMember = Readonly<{
  rateSnapshotId: string;
  corridorId: string;
  capturedAt: string;
  ageMs: number | null;
  eligibility: ReputationEvidenceEligibilityValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

export type ReputationManifestOutcomeMember = Readonly<{
  transferOutcomeId: string;
  corridorId: string;
  status: ReputationTransferStatus;
  recordedAt: string;
  eligibility: ReputationEvidenceEligibilityValue;
  reasonCode: ReputationEvidenceReasonCodeValue;
  ordinal: number;
}>;

/** Bounded, sanitized read model for one persisted manifest. */
export type ReputationManifestRecord = Readonly<{
  id: string;
  reputationScoreId: string;
  anchorSlug: string;
  anchorStatus: ReputationAnchorStatus;
  manifestSchemaVersion: number;
  reasonCodeVocabularyVersion: number;
  scoringPolicyVersion: string;
  freshnessPolicyVersion: string;
  configurationRevision: string;
  evaluatedAt: string;
  outcomeWindowStart: string;
  corridorCount: number;
  latestRateCount: number;
  freshRateCount: number;
  outcomeCount: number;
  completedOutcomeCount: number;
  outsideOutcomeCount: number;
  minimumOutcomeCount: number;
  createdAt: string;
  corridorMembers: readonly ReputationManifestCorridorMember[];
  rateMembers: readonly ReputationManifestRateMember[];
  outcomeMembers: readonly ReputationManifestOutcomeMember[];
}>;

export type ReputationManifestRepository = Readonly<{
  readManifest: (evaluationId: string) => Promise<ReputationManifestRecord | null>;
  readLatestManifestForAnchor: (
    anchorSlug: string,
  ) => Promise<ReputationManifestRecord | null>;
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
