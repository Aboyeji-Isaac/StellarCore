import {
  OperatorActionType as OperatorActionTypeValues,
  OperatorReasonCode as OperatorReasonCodeValues,
  OperatorTargetType as OperatorTargetTypeValues,
} from "@/app/generated/prisma/enums";
import type {
  OperatorActionType,
  OperatorReasonCode,
  OperatorTargetType,
} from "@/types/audit";

export type OperatorActionDefinition = Readonly<{
  actionType: OperatorActionType;
  targetType: OperatorTargetType;
  reasonCodes: readonly OperatorReasonCode[];
  description: string;
}>;

/**
 * Stable catalog of supported privileged actions. Each action declares exactly
 * one target type and the reviewed reason codes that may justify it, so an
 * action cannot be recorded against an incompatible target or an unreviewed
 * reason. Extending the vocabulary is a reviewed migration plus an entry here.
 */
function reasons(...codes: OperatorReasonCode[]): readonly OperatorReasonCode[] {
  return Object.freeze(codes);
}

export const OPERATOR_ACTION_CATALOG: readonly OperatorActionDefinition[] = Object.freeze([
  Object.freeze({
    actionType: "RATE_SNAPSHOT_INVALIDATED" as const,
    targetType: "RATE_SNAPSHOT" as const,
    reasonCodes: reasons(
      "SOURCE_ERROR",
      "DUPLICATE_OBSERVATION",
      "STALE_ARTIFACT",
      "DATA_CORRECTION",
      "OTHER_REVIEWED",
    ),
    description:
      "Marks one persisted rate snapshot ineligible for the latest-rate read model. It is an administrative disposition, not proof of malicious behavior.",
  }),
  Object.freeze({
    actionType: "RATE_SNAPSHOT_SUPERSEDED" as const,
    targetType: "RATE_SNAPSHOT" as const,
    reasonCodes: reasons("DUPLICATE_OBSERVATION", "DATA_CORRECTION", "OTHER_REVIEWED"),
    description:
      "Marks one persisted rate snapshot as replaced by a reviewed observation while keeping the historical row unchanged.",
  }),
  Object.freeze({
    actionType: "RATE_DISPOSITION_RECOVERED" as const,
    targetType: "RATE_SNAPSHOT" as const,
    reasonCodes: reasons("OPERATOR_RECOVERY", "DATA_CORRECTION"),
    description:
      "Recovers a previously disposed rate snapshot so it can participate in the latest-rate read model again.",
  }),
  Object.freeze({
    actionType: "ANCHOR_RETIRED" as const,
    targetType: "ANCHOR" as const,
    reasonCodes: reasons("REVIEWED_CONFIGURATION_REMOVAL", "STALE_ARTIFACT", "OTHER_REVIEWED"),
    description:
      "Removes a persisted anchor from reviewed configuration. It does not assert external downtime or anchor behavior.",
  }),
  Object.freeze({
    actionType: "ANCHOR_REACTIVATED" as const,
    targetType: "ANCHOR" as const,
    reasonCodes: reasons("OPERATOR_RECOVERY", "OTHER_REVIEWED"),
    description:
      "Restores a retired anchor to reviewed configuration after an explicit operator recovery review.",
  }),
]);

const ACTION_DEFINITIONS = new Map<OperatorActionType, OperatorActionDefinition>(
  OPERATOR_ACTION_CATALOG.map((definition) => [definition.actionType, definition]),
);

export function getOperatorActionDefinition(
  actionType: OperatorActionType,
): OperatorActionDefinition | undefined {
  return ACTION_DEFINITIONS.get(actionType);
}

export function isOperatorActionType(value: unknown): value is OperatorActionType {
  return typeof value === "string"
    && (Object.values(OperatorActionTypeValues) as readonly string[]).includes(value);
}

export function isOperatorReasonCode(value: unknown): value is OperatorReasonCode {
  return typeof value === "string"
    && (Object.values(OperatorReasonCodeValues) as readonly string[]).includes(value);
}

export function isOperatorTargetType(value: unknown): value is OperatorTargetType {
  return typeof value === "string"
    && (Object.values(OperatorTargetTypeValues) as readonly string[]).includes(value);
}

export function isReasonCodeAllowed(
  actionType: OperatorActionType,
  reasonCode: OperatorReasonCode,
): boolean {
  return getOperatorActionDefinition(actionType)?.reasonCodes.includes(reasonCode) ?? false;
}

export function operatorActionTypes(): readonly OperatorActionType[] {
  return Object.freeze(OPERATOR_ACTION_CATALOG.map((definition) => definition.actionType));
}

export function operatorReasonCodes(): readonly OperatorReasonCode[] {
  return Object.freeze([...new Set(
    OPERATOR_ACTION_CATALOG.flatMap((definition) => [...definition.reasonCodes]),
  )].sort((left, right) => left.localeCompare(right)));
}
