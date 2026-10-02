import { CONTROL_CHARACTER_PATTERN, OPERATOR_ACTION_LIMITS, OPERATOR_IDENTIFIER_PATTERN } from "@/constants/audit";
import { isValidActorId } from "@/lib/audit/actor";
import {
  getOperatorActionDefinition,
  isOperatorActionType,
  isOperatorReasonCode,
  isReasonCodeAllowed,
} from "@/lib/audit/vocabulary";
import type {
  OperatorActionValidationIssue,
  RecordOperatorActionInput,
} from "@/types/audit";

/**
 * Pure validation of one would-be ledger entry. It never throws and never
 * echoes a value, so issues can be surfaced safely by callers and tooling.
 */
export function validateOperatorActionInput(
  input: RecordOperatorActionInput,
): readonly OperatorActionValidationIssue[] {
  const issues: OperatorActionValidationIssue[] = [];

  if (!isOperatorActionType(input.actionType)) {
    issues.push({ field: "actionType", code: "NOT_IN_VOCABULARY" });
  }
  if (!isOperatorReasonCode(input.reasonCode)) {
    issues.push({ field: "reasonCode", code: "NOT_IN_VOCABULARY" });
  }

  const definition = isOperatorActionType(input.actionType)
    ? getOperatorActionDefinition(input.actionType)
    : undefined;

  if (!definition) {
    return Object.freeze(issues.map(freezeIssue));
  }

  if (input.targetType !== definition.targetType) {
    issues.push({ field: "targetType", code: "INCOMPATIBLE_TARGET" });
  }

  if (
    isOperatorReasonCode(input.reasonCode)
    && !isReasonCodeAllowed(input.actionType, input.reasonCode)
  ) {
    issues.push({ field: "reasonCode", code: "REASON_NOT_ALLOWED" });
  }

  issues.push(...validateBoundedText("targetId", input.targetId, {
    maxLength: OPERATOR_ACTION_LIMITS.targetIdMaxLength,
  }));
  issues.push(...validateBoundedText("targetLabel", input.targetLabel, {
    maxLength: OPERATOR_ACTION_LIMITS.targetLabelMaxLength,
  }));
  issues.push(...validateBoundedText("rationale", input.rationale, {
    maxLength: OPERATOR_ACTION_LIMITS.rationaleMaxLength,
  }));

  issues.push(...validateIdentifier("runId", input.runId, OPERATOR_ACTION_LIMITS.runIdMaxLength));
  issues.push(...validateIdentifier("actionId", input.actionId, OPERATOR_ACTION_LIMITS.actionIdMaxLength));

  if (input.actor.kind === "human" && !isValidActorId(input.actor.id)) {
    issues.push({ field: "actor", code: "INVALID_ACTOR_ID" });
  }

  if (input.createdAt !== undefined && !Number.isFinite(input.createdAt.getTime())) {
    issues.push({ field: "createdAt", code: "INVALID_DATE" });
  }

  return Object.freeze(issues.map(freezeIssue));
}

function validateBoundedText(
  field: "targetId" | "targetLabel" | "rationale",
  value: string | undefined,
  options: Readonly<{ maxLength: number }>,
): readonly OperatorActionValidationIssue[] {
  if (value === undefined) return Object.freeze([]);
  const token = value.trim();
  if (token.length === 0) return Object.freeze([{ field, code: "EMPTY" as const }]);
  if (token.length > options.maxLength) {
    return Object.freeze([{ field, code: "TOO_LONG" as const }]);
  }
  if (CONTROL_CHARACTER_PATTERN.test(token)) {
    return Object.freeze([{ field, code: "INVALID_FORMAT" as const }]);
  }
  return Object.freeze([]);
}

function validateIdentifier(
  field: "actionId" | "runId",
  value: string | undefined,
  maxLength: number,
): readonly OperatorActionValidationIssue[] {
  if (value === undefined) return Object.freeze([]);
  const token = value.trim();
  if (token.length === 0) return Object.freeze([{ field, code: "EMPTY" as const }]);
  if (token.length > maxLength) return Object.freeze([{ field, code: "TOO_LONG" as const }]);
  if (!OPERATOR_IDENTIFIER_PATTERN.test(token)) {
    return Object.freeze([{ field, code: "INVALID_FORMAT" as const }]);
  }
  return Object.freeze([]);
}

function freezeIssue(issue: OperatorActionValidationIssue): OperatorActionValidationIssue {
  return Object.freeze({ ...issue });
}
