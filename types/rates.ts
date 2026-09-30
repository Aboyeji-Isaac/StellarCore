import type { CorridorRegistryEntry } from "@/types/corridor";
import type {
  Sep38IndicativePrice,
  Sep38IndicativePriceRequest,
} from "@/types/sep38";

export type NormalizedRateObservation = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

export type RateFreshnessState = "fresh" | "stale" | "future" | "invalid";

export type RateFreshness = Readonly<{
  state: RateFreshnessState;
  ageMs: number | null;
}>;

export type MedianSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: Date | string;
  /**
   * Set by the anomaly layer (issue #186). A quarantined source is retained as
   * evidence but can never be counted toward the median or its threshold.
   */
  quarantined?: boolean;
}>;

export type MedianExclusionReason =
  | "quarantined"
  | "stale"
  | "future_timestamp"
  | "invalid_timestamp"
  | "invalid_rate";

export type MedianSourceResult = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: Date | string;
  quarantined?: boolean;
  included: boolean;
  exclusionReason?: MedianExclusionReason;
}>;

export type MedianResult = Readonly<{
  state: "healthy" | "insufficient_fresh_sources";
  median: string | null;
  freshSourceCount: number;
  sources: readonly MedianSourceResult[];
}>;

export type PersistedRateSnapshot = Readonly<{
  id: string;
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  sourceAmount: string;
  destinationAmount: string;
  fee: string;
  capturedAt: Date;
}>;

export type RateSnapshotPersistenceCode =
  | "ANCHOR_NOT_FOUND"
  | "CORRIDOR_NOT_FOUND"
  | "ASSOCIATION_NOT_FOUND"
  | "PERSISTENCE_FAILURE"
  | "ENVIRONMENT_MISMATCH";

export type RateSnapshotPersistenceResult =
  | Readonly<{ ok: true; snapshot: PersistedRateSnapshot }>
  | Readonly<{ ok: false; code: RateSnapshotPersistenceCode }>;

export type RateSnapshotRepository = Readonly<{
  findAnchorBySlug: (slug: string) => Promise<Readonly<{ id: string }> | null>;
  findCorridorBySlug: (slug: string) => Promise<Readonly<{ id: string }> | null>;
  hasAssociation: (anchorId: string, corridorId: string) => Promise<boolean>;
  createSnapshot: (input: Readonly<{
    anchorId: string;
    corridorId: string;
    rate: string;
    sourceAmount: string;
    destinationAmount: string;
    fee: string;
    capturedAt: Date;
  }>) => Promise<Readonly<{
    id: string;
    rate: { toString(): string } | string;
    sourceAmount: { toString(): string } | string;
    destinationAmount: { toString(): string } | string;
    fee: { toString(): string } | string;
    capturedAt: Date;
  }>>;
}>;

export type RateCandidate = Readonly<{
  anchorSlug: string;
  corridor: CorridorRegistryEntry;
  request: Sep38IndicativePriceRequest;
}>;

export type RateQuoteProvider = (
  candidate: RateCandidate,
) => Promise<Sep38IndicativePrice>;

export type RateEngineFailure = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  phase: "QUOTE" | "NORMALIZATION" | "PERSISTENCE";
  code: string;
}>;

export type RateEngineSkippedSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  reason: "DUPLICATE_CANDIDATE";
}>;

export type RateEngineResult = Readonly<{
  totalCandidates: number;
  totalAttempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  snapshotsPersisted: number;
  snapshots: readonly PersistedRateSnapshot[];
  failures: readonly RateEngineFailure[];
  skippedSources: readonly RateEngineSkippedSource[];
}>;

/**
 * Cross-source anomaly verdicts (issue #186). Only "quarantined" removes an
 * observation from median eligibility; "insufficient_peers" and
 * "unassessable" deliberately carry no anomaly verdict.
 */
export type RateAnomalyStatus =
  | "consistent"
  | "quarantined"
  | "insufficient_peers"
  | "unassessable";

export type RateAnomalyReason =
  | "deviates_from_peer_consensus"
  | "fewer_than_minimum_independent_peers"
  | "no_peer_consensus"
  | "invalid_rate"
  | "invalid_timestamp";

export type RateAnomalyObservation = Readonly<{
  id: string;
  /**
   * The unit of independence. On main this is the anchor slug, the same unit
   * selectLatestPerAnchor and the median count; observations sharing a key
   * never corroborate each other.
   */
  independenceKey: string;
  rate: string;
  capturedAt: Date | string;
}>;

export type RateAnomalyAssessment = Readonly<{
  observationId: string;
  independenceKey: string;
  status: RateAnomalyStatus;
  reason: RateAnomalyReason | null;
  criterionVersion: string;
  baselineRate: string | null;
  toleranceBps: number;
  contemporaneityWindowMs: number;
  independentPeerCount: number;
  agreeingPeerCount: number;
  peerObservationIds: readonly string[];
}>;

/** Safe internal diagnostic for one quarantined observation. No payloads. */
export type RateAnomalyDiagnostic = Readonly<{
  snapshotId: string;
  anchorSlug: string;
  corridorSlug: string;
  status: RateAnomalyStatus;
  reason: RateAnomalyReason | null;
  baselineRate: string | null;
  independentPeerCount: number;
  agreeingPeerCount: number;
  toleranceBps: number;
}>;

export type CorridorAnomalyAssessmentSummary = Readonly<{
  corridorsAssessed: number;
  assessmentsAppended: number;
  quarantined: readonly RateAnomalyDiagnostic[];
  failures: readonly Readonly<{ corridorSlug: string; code: "ANOMALY_ASSESSMENT_FAILURE" }>[];
}>;
