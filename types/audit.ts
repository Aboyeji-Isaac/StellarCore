import type {
  OperatorActionMode,
  OperatorActionType,
  OperatorActorType,
  OperatorReasonCode,
  OperatorTargetType,
} from "@/app/generated/prisma/enums";

export type {
  OperatorActionMode,
  OperatorActionType,
  OperatorActorType,
  OperatorReasonCode,
  OperatorTargetType,
};

/**
 * Truthful actor origin. A human actor carries only the identity supplied by a
 * trusted authentication boundary; the audit layer never invents one.
 */
export type OperatorActor =
  | Readonly<{ kind: "system" }>
  | Readonly<{ kind: "human"; id: string }>;

/** Administrative operations require an explicit dry-run or apply mode. */
export type AdministrativeOperationMode = "dry-run" | "apply";

export type RecordOperatorActionInput = Readonly<{
  actionId?: string;
  actionType: OperatorActionType;
  targetType: OperatorTargetType;
  targetId: string;
  targetLabel?: string;
  reasonCode: OperatorReasonCode;
  rationale?: string;
  actor: OperatorActor;
  runId?: string;
  createdAt?: Date;
}>;

/** One persisted, immutable ledger row describing an already-applied action. */
export type OperatorActionRecord = Readonly<{
  id: string;
  actionId: string;
  actionType: OperatorActionType;
  mode: "APPLIED";
  targetType: OperatorTargetType;
  targetId: string;
  targetLabel: string | null;
  reasonCode: OperatorReasonCode;
  rationale: string | null;
  actorType: OperatorActorType;
  actorId: string | null;
  runId: string | null;
  createdAt: Date;
}>;

/**
 * Deterministic, bounded preview of an action that a dry run would apply. It
 * deliberately omits the generated row id and wall-clock timestamp so the same
 * request always previews identically, and it is never persisted.
 */
export type OperatorActionPreview = Readonly<{
  actionId: string | null;
  actionType: OperatorActionType;
  mode: "DRY_RUN";
  targetType: OperatorTargetType;
  targetId: string;
  targetLabel: string | null;
  reasonCode: OperatorReasonCode;
  rationale: string | null;
  actorType: OperatorActorType;
  actorId: string | null;
  runId: string | null;
}>;

export type OperatorActionValidationIssue = Readonly<{
  field:
    | "actionId"
    | "actionType"
    | "actor"
    | "createdAt"
    | "rationale"
    | "reasonCode"
    | "runId"
    | "targetId"
    | "targetLabel"
    | "targetType";
  code:
    | "EMPTY"
    | "INVALID_ACTOR_ID"
    | "INVALID_DATE"
    | "INVALID_FORMAT"
    | "INCOMPATIBLE_TARGET"
    | "NOT_IN_VOCABULARY"
    | "REASON_NOT_ALLOWED"
    | "TOO_LONG";
}>;

/** Read-only inspection queries. The ledger has no mutation interface. */
export type OperatorActionInspectionQuery =
  | Readonly<{ kind: "target"; targetType: OperatorTargetType; targetId: string; limit?: number }>
  | Readonly<{ kind: "run"; runId: string; limit?: number }>
  | Readonly<{ kind: "recent"; limit?: number }>;
