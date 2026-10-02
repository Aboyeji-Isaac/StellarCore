import { randomUUID } from "node:crypto";

import type { Prisma } from "@/app/generated/prisma/client";
import type { OperatorActionMode } from "@/app/generated/prisma/enums";
import { operatorActorColumns } from "@/lib/audit/actor";
import { validateOperatorActionInput } from "@/lib/audit/validation";
import type {
  OperatorActionPreview,
  OperatorActionRecord,
  OperatorActionValidationIssue,
  RecordOperatorActionInput,
} from "@/types/audit";

export class OperatorActionValidationError extends Error {
  readonly code = "INVALID_OPERATOR_ACTION";
  readonly issues: readonly OperatorActionValidationIssue[];

  constructor(issues: readonly OperatorActionValidationIssue[]) {
    super("Invalid operator action");
    this.name = "OperatorActionValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

/** Minimal executor surface: a plain client or an open transaction both work. */
export type OperatorActionExecutor = Pick<Prisma.TransactionClient, "operatorAction">;

type OperatorActionRow = Readonly<{
  id: string;
  actionId: string;
  actionType: OperatorActionRecord["actionType"];
  mode: OperatorActionMode;
  targetType: OperatorActionRecord["targetType"];
  targetId: string;
  targetLabel: string | null;
  reasonCode: OperatorActionRecord["reasonCode"];
  rationale: string | null;
  actorType: OperatorActionRecord["actorType"];
  actorId: string | null;
  runId: string | null;
  createdAt: Date;
}>;

export const OPERATOR_ACTION_SELECT = {
  id: true,
  actionId: true,
  actionType: true,
  mode: true,
  targetType: true,
  targetId: true,
  targetLabel: true,
  reasonCode: true,
  rationale: true,
  actorType: true,
  actorId: true,
  runId: true,
  createdAt: true,
} as const;

export function assertValidOperatorAction(input: RecordOperatorActionInput): void {
  const issues = validateOperatorActionInput(input);
  if (issues.length > 0) throw new OperatorActionValidationError(issues);
}

/**
 * Deterministic, bounded preview of the action a dry run would apply. It is
 * never persisted or returned as an applied record.
 */
export function buildOperatorActionPreview(
  input: RecordOperatorActionInput,
): OperatorActionPreview {
  assertValidOperatorAction(input);
  const actor = operatorActorColumns(input.actor);
  return Object.freeze({
    actionId: input.actionId?.trim() ?? null,
    actionType: input.actionType,
    mode: "DRY_RUN",
    targetType: input.targetType,
    targetId: input.targetId.trim(),
    targetLabel: input.targetLabel?.trim() ?? null,
    reasonCode: input.reasonCode,
    rationale: input.rationale?.trim() ?? null,
    actorType: actor.actorType,
    actorId: actor.actorId,
    runId: input.runId?.trim() ?? null,
  });
}

/**
 * Appends exactly one immutable ledger row using the supplied executor. When
 * the executor is an open transaction, the row commits atomically with the
 * administrative state change that called it.
 */
export async function appendOperatorAction(
  executor: OperatorActionExecutor,
  input: RecordOperatorActionInput,
  options: Readonly<{ actionId?: string; createdAt?: Date }> = {},
): Promise<OperatorActionRecord> {
  assertValidOperatorAction(input);
  const actor = operatorActorColumns(input.actor);
  const actionId = options.actionId ?? input.actionId?.trim() ?? randomUUID();
  const createdAt = options.createdAt ?? input.createdAt;

  const row = await executor.operatorAction.create({
    data: {
      actionId,
      actionType: input.actionType,
      mode: "APPLIED",
      targetType: input.targetType,
      targetId: input.targetId.trim(),
      targetLabel: normalizeOptional(input.targetLabel),
      reasonCode: input.reasonCode,
      rationale: normalizeOptional(input.rationale),
      actorType: actor.actorType,
      actorId: actor.actorId,
      runId: normalizeOptional(input.runId),
      ...(createdAt ? { createdAt } : {}),
    },
    select: OPERATOR_ACTION_SELECT,
  });

  return toOperatorActionRecord(row);
}

export function toOperatorActionRecord(row: OperatorActionRow): OperatorActionRecord {
  return Object.freeze({
    id: row.id,
    actionId: row.actionId,
    actionType: row.actionType,
    mode: "APPLIED",
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    reasonCode: row.reasonCode,
    rationale: row.rationale,
    actorType: row.actorType,
    actorId: row.actorId,
    runId: row.runId,
    createdAt: new Date(row.createdAt.getTime()),
  });
}

function normalizeOptional(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = value.trim();
  return token.length > 0 ? token : null;
}
