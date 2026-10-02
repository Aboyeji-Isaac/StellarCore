import "dotenv/config";

import { pathToFileURL } from "node:url";

import { OPERATOR_ACTION_LIMITS } from "@/constants/audit";
import {
  PRISMA_OPERATOR_ACTION_LEDGER,
  boundLimit,
} from "@/lib/audit/ledgerRepository";
import { isOperatorTargetType } from "@/lib/audit/vocabulary";
import type { OperatorActionRecord, OperatorTargetType } from "@/types/audit";

/**
 * Read-only operator-audit inspection. It never writes, never retries, and
 * prints a deterministic, bounded, sanitized summary of already-persisted
 * ledger rows. The ledger is append-only, so there is nothing to modify here.
 *
 * Usage:
 *   tsx scripts/operator-audit.ts [--target-type=RATE_SNAPSHOT|ANCHOR --target-id=<id>]
 *                                 [--run-id=<id>] [--limit=<n>]
 */

type InspectionQuery =
  | Readonly<{ kind: "target"; targetType: OperatorTargetType; targetId: string; limit: number }>
  | Readonly<{ kind: "run"; runId: string; limit: number }>
  | Readonly<{ kind: "recent"; limit: number }>;

type ParsedArguments = Readonly<{
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const limit = boundLimit(parseLimit(parsed.values.get("limit")));

  const query = resolveQuery(parsed, limit);
  const actions = query.kind === "target"
    ? await PRISMA_OPERATOR_ACTION_LEDGER.listByTarget(query.targetType, query.targetId, query.limit)
    : query.kind === "run"
      ? await PRISMA_OPERATOR_ACTION_LEDGER.listByRun(query.runId, query.limit)
      : await PRISMA_OPERATOR_ACTION_LEDGER.listRecent(query.limit);

  process.stdout.write(`${JSON.stringify({
    query: describeQuery(query),
    count: actions.length,
    actions: actions.map(toInspectionRow),
  }, null, 2)}\n`);
}

function resolveQuery(parsed: ParsedArguments, limit: number): InspectionQuery {
  const targetType = parsed.values.get("target-type");
  const targetId = parsed.values.get("target-id");
  const runId = parsed.values.get("run-id");

  if (targetType !== undefined && targetId !== undefined) {
    if (!isOperatorTargetType(targetType)) {
      throw new Error("--target-type must be RATE_SNAPSHOT or ANCHOR");
    }
    return Object.freeze({ kind: "target", targetType, targetId, limit });
  }

  if (runId !== undefined) {
    return Object.freeze({ kind: "run", runId, limit });
  }

  return Object.freeze({ kind: "recent", limit });
}

function describeQuery(query: InspectionQuery): Record<string, unknown> {
  switch (query.kind) {
    case "target":
      return { kind: "target", targetType: query.targetType, targetId: query.targetId, limit: query.limit };
    case "run":
      return { kind: "run", runId: query.runId, limit: query.limit };
    case "recent":
      return { kind: "recent", limit: query.limit };
  }
}

function toInspectionRow(record: OperatorActionRecord): Record<string, unknown> {
  return {
    actionId: record.actionId,
    actionType: record.actionType,
    mode: record.mode,
    targetType: record.targetType,
    targetId: record.targetId,
    targetLabel: record.targetLabel,
    reasonCode: record.reasonCode,
    rationale: record.rationale,
    actor: { type: record.actorType, id: record.actorId },
    runId: record.runId,
    createdAt: record.createdAt.toISOString(),
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return OPERATOR_ACTION_LIMITS.inspectionDefaultLimit;
  const value = Number(raw);
  return Number.isFinite(value) ? value : OPERATOR_ACTION_LIMITS.inspectionDefaultLimit;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const separator = body.indexOf("=");
    if (separator === -1) {
      flags.add(body);
    } else {
      values.set(body.slice(0, separator), body.slice(separator + 1));
    }
  }

  return Object.freeze({ values, flags });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "OPERATOR_AUDIT_FAILURE" })}\n`);
    process.exitCode = 1;
  });
}
