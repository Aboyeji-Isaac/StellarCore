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
}>;

export type MedianExclusionReason =
  | "stale"
  | "future_timestamp"
  | "invalid_timestamp"
  | "invalid_rate";

export type MedianSourceResult = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  rate: string;
  capturedAt: Date | string;
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
  /**
   * Durable capture-run identity for this observation. Null only for rows that
   * predate scheduled capture; the capture boundary never writes null.
   */
  captureRunId: string | null;
}>;

/**
 * Lineage attached to one persistence attempt. Kept separate from the
 * normalized observation so quote normalization stays independent of how the
 * observation was scheduled.
 */
export type RateSnapshotLineage = Readonly<{
  captureRunId?: string | null;
}>;

export type RateSnapshotPersistenceCode =
  | "ANCHOR_NOT_FOUND"
  | "CORRIDOR_NOT_FOUND"
  | "ASSOCIATION_NOT_FOUND"
  | "PERSISTENCE_FAILURE";

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
    captureRunId: string | null;
  }>) => Promise<Readonly<{
    id: string;
    rate: { toString(): string } | string;
    sourceAmount: { toString(): string } | string;
    destinationAmount: { toString(): string } | string;
    fee: { toString(): string } | string;
    capturedAt: Date;
    captureRunId: string | null;
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

export type RateEngineSkippedSourceReason =
  | "DUPLICATE_CANDIDATE"
  /**
   * The bounded execution budget ran out before this reviewed source was
   * attempted. The source is reported as skipped rather than failed, and no
   * snapshot is fabricated for it on the next run or this one.
   */
  | "EXECUTION_BUDGET_EXHAUSTED";

export type RateEngineSkippedSource = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
  reason: RateEngineSkippedSourceReason;
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
