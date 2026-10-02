import type {
  AdministrativeOperationMode,
  OperatorActionPreview,
  OperatorActionRecord,
  OperatorActor,
  OperatorReasonCode,
} from "@/types/audit";

/** Common inputs for a reviewed administrative request. */
export type AdministratorRequestBase = Readonly<{
  mode: AdministrativeOperationMode;
  actor: OperatorActor;
  reasonCode: OperatorReasonCode;
  rationale?: string;
  runId?: string;
  actionId?: string;
}>;

export type RateSnapshotDispositionKind = "INVALIDATED" | "SUPERSEDED";

export type RateSnapshotTarget = Readonly<{
  snapshotId: string;
  anchorSlug: string;
  corridorSlug: string;
  capturedAt: Date;
}>;

export type RateDispositionRequest = AdministratorRequestBase & Readonly<{
  snapshotId: string;
  disposition: RateSnapshotDispositionKind;
}>;

export type RateDispositionRecoveryRequest = AdministratorRequestBase & Readonly<{
  snapshotId: string;
}>;

export type RateDispositionRejectionCode =
  | "ALREADY_DISPOSED"
  | "INVALID_INPUT"
  | "NOT_DISPOSED"
  | "TARGET_NOT_FOUND";

export type RateDispositionOutcome =
  | Readonly<{
      status: "dry_run";
      snapshot: RateSnapshotTarget;
      action: OperatorActionPreview;
    }>
  | Readonly<{
      status: "applied";
      snapshot: RateSnapshotTarget;
      disposition: RateSnapshotDispositionKind;
      action: OperatorActionRecord;
    }>
  | Readonly<{ status: "rejected"; code: RateDispositionRejectionCode }>;

export type RateDispositionRecoveryOutcome =
  | Readonly<{
      status: "dry_run";
      snapshot: RateSnapshotTarget;
      action: OperatorActionPreview;
    }>
  | Readonly<{
      status: "applied";
      snapshot: RateSnapshotTarget;
      action: OperatorActionRecord;
    }>
  | Readonly<{ status: "rejected"; code: RateDispositionRejectionCode }>;

export type AnchorLifecycleState = "ACTIVE" | "RETIRED";

export type AnchorLifecycleTarget = Readonly<{
  anchorId: string;
  slug: string;
  lifecycleState: AnchorLifecycleState;
}>;

export type RegistryLifecycleRequest = AdministratorRequestBase & Readonly<{
  anchorSlug: string;
}>;

export type RegistryLifecycleRejectionCode =
  | "ALREADY_RETIRED"
  | "INVALID_INPUT"
  | "NOT_RETIRED"
  | "TARGET_NOT_FOUND";

export type RegistryLifecycleOutcome =
  | Readonly<{
      status: "dry_run";
      anchor: AnchorLifecycleTarget;
      action: OperatorActionPreview;
    }>
  | Readonly<{
      status: "applied";
      anchor: AnchorLifecycleTarget;
      action: OperatorActionRecord;
    }>
  | Readonly<{ status: "rejected"; code: RegistryLifecycleRejectionCode }>;
