import { OPERATOR_ACTION_LIMITS } from "@/constants/audit";
import {
  OPERATOR_ACTION_SELECT,
  appendOperatorAction,
  toOperatorActionRecord,
} from "@/lib/audit/recordOperatorAction";
import type {
  OperatorActionInspectionQuery,
  OperatorActionRecord,
  OperatorTargetType,
  RecordOperatorActionInput,
} from "@/types/audit";

/**
 * The only application interface to the ledger. It exposes append and bounded
 * reads; there is deliberately no update or delete method, and the database
 * additionally rejects those operations with an append-only trigger.
 */
export type OperatorActionLedger = Readonly<{
  append: (input: RecordOperatorActionInput) => Promise<OperatorActionRecord>;
  listByTarget: (
    targetType: OperatorTargetType,
    targetId: string,
    limit?: number,
  ) => Promise<readonly OperatorActionRecord[]>;
  listByRun: (runId: string, limit?: number) => Promise<readonly OperatorActionRecord[]>;
  listRecent: (limit?: number) => Promise<readonly OperatorActionRecord[]>;
  inspect: (query: OperatorActionInspectionQuery) => Promise<readonly OperatorActionRecord[]>;
}>;

export const PRISMA_OPERATOR_ACTION_LEDGER: OperatorActionLedger = Object.freeze({
  async append(input) {
    const { db } = await import("@/lib/dbClient");
    return appendOperatorAction(db, input);
  },

  async listByTarget(targetType, targetId, limit = OPERATOR_ACTION_LIMITS.inspectionDefaultLimit) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.operatorAction.findMany({
      where: { targetType, targetId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: boundLimit(limit),
      select: OPERATOR_ACTION_SELECT,
    });
    return Object.freeze(rows.map(toOperatorActionRecord));
  },

  async listByRun(runId, limit = OPERATOR_ACTION_LIMITS.inspectionDefaultLimit) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.operatorAction.findMany({
      where: { runId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: boundLimit(limit),
      select: OPERATOR_ACTION_SELECT,
    });
    return Object.freeze(rows.map(toOperatorActionRecord));
  },

  async listRecent(limit = OPERATOR_ACTION_LIMITS.inspectionDefaultLimit) {
    const { db } = await import("@/lib/dbClient");
    const rows = await db.operatorAction.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: boundLimit(limit),
      select: OPERATOR_ACTION_SELECT,
    });
    return Object.freeze(rows.map(toOperatorActionRecord));
  },

  async inspect(query) {
    switch (query.kind) {
      case "target":
        return this.listByTarget(query.targetType, query.targetId, query.limit);
      case "run":
        return this.listByRun(query.runId, query.limit);
      case "recent":
        return this.listRecent(query.limit);
    }
  },
});

export function boundLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return OPERATOR_ACTION_LIMITS.inspectionDefaultLimit;
  }
  const integer = Math.trunc(limit);
  if (integer < 1) return 1;
  return Math.min(integer, OPERATOR_ACTION_LIMITS.inspectionMaxLimit);
}
