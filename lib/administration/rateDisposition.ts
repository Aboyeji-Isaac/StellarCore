import { buildOperatorActionPreview } from "@/lib/audit/recordOperatorAction";
import { validateOperatorActionInput } from "@/lib/audit/validation";
import { isOperatorReasonCode } from "@/lib/audit/vocabulary";
import type {
  RateDispositionOutcome,
  RateDispositionRecoveryOutcome,
  RateDispositionRecoveryRequest,
  RateDispositionRejectionCode,
  RateDispositionRequest,
  RateSnapshotDispositionKind,
  RateSnapshotTarget,
} from "@/types/administration";
import type {
  OperatorActionRecord,
  OperatorReasonCode,
  RecordOperatorActionInput,
} from "@/types/audit";

export type ApplyRateDispositionRepositoryInput = Readonly<{
  snapshot: RateSnapshotTarget;
  disposition: RateSnapshotDispositionKind;
  reasonCode: OperatorReasonCode;
  rationale?: string;
  action: RecordOperatorActionInput;
}>;

export type ClearRateDispositionRepositoryInput = Readonly<{
  snapshot: RateSnapshotTarget;
  reasonCode: OperatorReasonCode;
  rationale?: string;
  action: RecordOperatorActionInput;
}>;

/**
 * Repository contract. `applyDisposition` and `clearDisposition` must perform
 * the state change and the ledger append in one transaction so the audit row
 * exists if and only if the state change committed.
 */
export type RateDispositionRepository = Readonly<{
  findSnapshot: (snapshotId: string) => Promise<RateSnapshotTarget | null>;
  findDisposition: (snapshotId: string) => Promise<RateSnapshotDispositionKind | null>;
  applyDisposition: (input: ApplyRateDispositionRepositoryInput) => Promise<
    | Readonly<{ ok: true; disposition: RateSnapshotDispositionKind; action: OperatorActionRecord }>
    | Readonly<{ ok: false; code: "TARGET_NOT_FOUND" | "ALREADY_DISPOSED" }>
  >;
  clearDisposition: (input: ClearRateDispositionRepositoryInput) => Promise<
    | Readonly<{ ok: true; action: OperatorActionRecord }>
    | Readonly<{ ok: false; code: "TARGET_NOT_FOUND" | "NOT_DISPOSED" }>
  >;
}>;

export type RateDispositionDependencies = Readonly<{
  repository: RateDispositionRepository;
}>;

export const RATE_DISPOSITION_ACTION_TYPE: Readonly<{
  INVALIDATED: "RATE_SNAPSHOT_INVALIDATED";
  SUPERSEDED: "RATE_SNAPSHOT_SUPERSEDED";
}> = Object.freeze({
  INVALIDATED: "RATE_SNAPSHOT_INVALIDATED",
  SUPERSEDED: "RATE_SNAPSHOT_SUPERSEDED",
});

export function isRateDispositionKind(value: unknown): value is RateSnapshotDispositionKind {
  return value === "INVALIDATED" || value === "SUPERSEDED";
}

export async function runRateDisposition(
  request: RateDispositionRequest,
  dependencies: RateDispositionDependencies,
): Promise<RateDispositionOutcome> {
  if (!isRateDispositionKind(request.disposition)) {
    return rejected("INVALID_INPUT");
  }

  const snapshotId = request.snapshotId?.trim() ?? "";
  if (snapshotId.length === 0) return rejected("INVALID_INPUT");

  const snapshot = await dependencies.repository.findSnapshot(snapshotId);
  if (!snapshot) return rejected("TARGET_NOT_FOUND");

  const actionInput = buildDispositionActionInput(request, snapshot);
  if (validateOperatorActionInput(actionInput).length > 0) {
    return rejected("INVALID_INPUT");
  }

  // A dry run simulates the same preconditions as an apply so it can never
  // preview an action that apply would refuse.
  const existing = await dependencies.repository.findDisposition(snapshotId);
  if (existing) return rejected("ALREADY_DISPOSED");

  if (request.mode === "dry-run") {
    return Object.freeze({
      status: "dry_run",
      snapshot,
      action: buildOperatorActionPreview(actionInput),
    });
  }

  const applied = await dependencies.repository.applyDisposition({
    snapshot,
    disposition: request.disposition,
    reasonCode: request.reasonCode,
    ...(request.rationale !== undefined ? { rationale: request.rationale } : {}),
    action: actionInput,
  });

  if (!applied.ok) return rejected(applied.code);

  return Object.freeze({
    status: "applied",
    snapshot,
    disposition: applied.disposition,
    action: applied.action,
  });
}

export async function runRateDispositionRecovery(
  request: RateDispositionRecoveryRequest,
  dependencies: RateDispositionDependencies,
): Promise<RateDispositionRecoveryOutcome> {
  if (!isOperatorReasonCode(request.reasonCode)) return rejected("INVALID_INPUT");

  const snapshotId = request.snapshotId?.trim() ?? "";
  if (snapshotId.length === 0) return rejected("INVALID_INPUT");

  const snapshot = await dependencies.repository.findSnapshot(snapshotId);
  if (!snapshot) return rejected("TARGET_NOT_FOUND");

  const actionInput: RecordOperatorActionInput = {
    ...(request.actionId !== undefined ? { actionId: request.actionId } : {}),
    actionType: "RATE_DISPOSITION_RECOVERED",
    targetType: "RATE_SNAPSHOT",
    targetId: snapshot.snapshotId,
    targetLabel: rateTargetLabel(snapshot),
    reasonCode: request.reasonCode,
    ...(request.rationale !== undefined ? { rationale: request.rationale } : {}),
    actor: request.actor,
    ...(request.runId !== undefined ? { runId: request.runId } : {}),
  };

  if (validateOperatorActionInput(actionInput).length > 0) {
    return rejected("INVALID_INPUT");
  }

  const existing = await dependencies.repository.findDisposition(snapshotId);
  if (!existing) return rejected("NOT_DISPOSED");

  if (request.mode === "dry-run") {
    return Object.freeze({
      status: "dry_run",
      snapshot,
      action: buildOperatorActionPreview(actionInput),
    });
  }

  const applied = await dependencies.repository.clearDisposition({
    snapshot,
    reasonCode: request.reasonCode,
    ...(request.rationale !== undefined ? { rationale: request.rationale } : {}),
    action: actionInput,
  });

  if (!applied.ok) return rejected(applied.code);

  return Object.freeze({ status: "applied", snapshot, action: applied.action });
}

function buildDispositionActionInput(
  request: RateDispositionRequest,
  snapshot: RateSnapshotTarget,
): RecordOperatorActionInput {
  return {
    ...(request.actionId !== undefined ? { actionId: request.actionId } : {}),
    actionType: RATE_DISPOSITION_ACTION_TYPE[request.disposition],
    targetType: "RATE_SNAPSHOT",
    targetId: snapshot.snapshotId,
    targetLabel: rateTargetLabel(snapshot),
    reasonCode: request.reasonCode,
    ...(request.rationale !== undefined ? { rationale: request.rationale } : {}),
    actor: request.actor,
    ...(request.runId !== undefined ? { runId: request.runId } : {}),
  };
}

function rateTargetLabel(snapshot: RateSnapshotTarget): string {
  return `${snapshot.anchorSlug}/${snapshot.corridorSlug}`;
}

function rejected(
  code: RateDispositionRejectionCode,
): Extract<RateDispositionOutcome, { status: "rejected" }> {
  return Object.freeze({ status: "rejected", code });
}
