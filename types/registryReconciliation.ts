import type { AnchorRegistryEntry } from "@/types/anchor";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

export type ReconciliationAnchorField = "name" | "homeDomain" | "tomlUrl";

export type ReconciliationCorridorField =
  | "assetCodeFrom"
  | "countryFrom"
  | "assetCodeTo"
  | "countryTo";

export type ReconciliationIssueCode =
  | "MISSING_ANCHOR"
  | "MISSING_CORRIDOR"
  | "UNEXPECTED_ANCHOR"
  | "UNEXPECTED_CORRIDOR"
  | "ANCHOR_FIELD_MISMATCH"
  | "CORRIDOR_FIELD_MISMATCH"
  | "MISSING_ASSOCIATION"
  | "UNEXPECTED_ASSOCIATION"
  | "ORPHANED_ANCHOR_LINK"
  | "ORPHANED_CORRIDOR_LINK"
  | "ORPHANED_RATE_SNAPSHOT"
  | "ORPHANED_TRANSFER_OUTCOME"
  | "STALE_ANCHOR"
  | "STALE_CORRIDOR";

export type ReconciliationEntityKind =
  | "anchor"
  | "corridor"
  | "anchor_corridor"
  | "rate_snapshot"
  | "transfer_outcome";

/**
 * A database row that participates in reconciliation. Slugs and route tuples
 * are the natural keys this auditor reasons about; surrogate UUIDs never leak
 * into findings or plans because they are environment-specific.
 */
export type PersistedAnchorRecord = Readonly<{
  slug: string;
  name: string;
  homeDomain: string;
  tomlUrl: string;
  status: string;
  corridorCount: number;
  rateSnapshotCount: number;
  transferOutcomeCount: number;
}>;

export type PersistedCorridorRecord = Readonly<{
  slug: string;
  assetCodeFrom: string;
  countryFrom: string;
  assetCodeTo: string;
  countryTo: string;
  anchorCount: number;
  rateSnapshotCount: number;
  transferOutcomeCount: number;
}>;

export type PersistedAssociationRecord = Readonly<{
  anchorSlug: string;
  corridorSlug: string;
}>;

export type PersistedReconciliationState = Readonly<{
  anchors: readonly PersistedAnchorRecord[];
  corridors: readonly PersistedCorridorRecord[];
  associations: readonly PersistedAssociationRecord[];
}>;

export type RegistryReconciliationInput = Readonly<{
  anchors: readonly AnchorRegistryEntry[];
  corridors: readonly CorridorRegistryEntry[];
  anchorCorridorMappings: readonly AnchorCorridorRegistryEntry[];
  persisted: PersistedReconciliationState;
}>;

export type ReconciliationIssue = Readonly<{
  code: ReconciliationIssueCode;
  entity: ReconciliationEntityKind;
  anchorSlug?: string;
  corridorSlug?: string;
  field?: ReconciliationAnchorField | ReconciliationCorridorField;
  expected?: string;
  actual?: string;
  historicalEvidenceCount?: number;
}>;

export type ReconciliationSummaryCounts = Readonly<{
  totalIssues: number;
  missingAnchors: number;
  missingCorridors: number;
  unexpectedAnchors: number;
  unexpectedCorridors: number;
  anchorFieldMismatches: number;
  corridorFieldMismatches: number;
  missingAssociations: number;
  unexpectedAssociations: number;
  orphanedAnchorLinks: number;
  orphanedCorridorLinks: number;
  orphanedRateSnapshots: number;
  orphanedTransferOutcomes: number;
  staleAnchors: number;
  staleCorridors: number;
}>;

/**
 * Historical evidence that would be affected by any retirement of unexpected
 * rows. Evidence is always visible in reports and never deleted by a plan.
 */
export type HistoricalEvidenceSummary = Readonly<{
  orphanedAnchors: number;
  orphanedCorridors: number;
  rateSnapshotsAttachedToOrphanedAnchors: number;
  rateSnapshotsAttachedToOrphanedCorridors: number;
  transferOutcomesAttachedToOrphanedAnchors: number;
  transferOutcomesAttachedToOrphanedCorridors: number;
}>;

export type ReconciliationResult = Readonly<{
  drift: boolean;
  issues: readonly ReconciliationIssue[];
  summary: ReconciliationSummaryCounts;
  historicalEvidence: HistoricalEvidenceSummary;
}>;

export type ReconciliationRepairActionKind =
  | "CREATE_ANCHOR"
  | "UPDATE_ANCHOR"
  | "CREATE_CORRIDOR"
  | "UPDATE_CORRIDOR"
  | "CREATE_ASSOCIATION"
  | "REMOVE_ASSOCIATION"
  | "RETIRE_ANCHOR"
  | "RETIRE_CORRIDOR";

/**
 * A single deterministic repair step. For field updates, `field` names the
 * drifted column and `expected` carries the reviewed registry value that a
 * repair would write.
 */
export type ReconciliationRepairAction = Readonly<{
  kind: ReconciliationRepairActionKind;
  entity: "anchor" | "corridor" | "anchor_corridor";
  anchorSlug?: string;
  corridorSlug?: string;
  field?: ReconciliationAnchorField | ReconciliationCorridorField;
  expected?: string;
  historicalEvidenceCount?: number;
  requiresManualReview: boolean;
  blockedByHistoricalEvidence: boolean;
}>;

/**
 * A deterministic, never-applied repair plan. `safeActions` are
 * evidence-independent upserts; `manualReviewActions` change persisted
 * relationships or delete rows without evidence and always require an
 * explicit maintainer decision; `skippedEvidenceDeletions` are refused
 * outright because historical evidence would be destroyed.
 */
export type RegistryRepairPlan = Readonly<{
  safeActions: readonly ReconciliationRepairAction[];
  manualReviewActions: readonly ReconciliationRepairAction[];
  skippedEvidenceDeletions: readonly ReconciliationRepairAction[];
  appliesWithoutManualAction: boolean;
}>;

export type RegistryReconciliationReport = Readonly<{
  result: ReconciliationResult;
  plan: RegistryRepairPlan;
}>;
