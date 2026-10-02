import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  isRateDispositionKind,
  runRateDisposition,
  runRateDispositionRecovery,
} from "@/lib/administration/rateDisposition";
import { PRISMA_RATE_DISPOSITION_REPOSITORY } from "@/lib/administration/rateDispositionRepository";
import {
  runRegistryReactivation,
  runRegistryRetirement,
} from "@/lib/administration/registryLifecycle";
import { PRISMA_REGISTRY_LIFECYCLE_REPOSITORY } from "@/lib/administration/registryLifecycleRepository";
import { isOperatorReasonCode } from "@/lib/audit/vocabulary";
import type { OperatorActor, OperatorReasonCode } from "@/types/audit";

/**
 * Reviewed administrative operations with an explicit dry-run default. Nothing
 * is written unless `--apply` is passed, and every applied mutation creates
 * exactly one immutable ledger row atomically with its state change.
 *
 * The CLI is not an authentication boundary: without `--actor-id` the action is
 * truthfully recorded as system. Pass `--actor-id` only with an identity that
 * came from a trusted authorization boundary.
 *
 * Usage:
 *   tsx scripts/operator-action.ts invalidate-rate <snapshotId> --reason=<CODE> [--rationale=<text>] [--run-id=<id>] [--actor-id=<id>] [--apply]
 *   tsx scripts/operator-action.ts supersede-rate  <snapshotId> --reason=<CODE> [...]
 *   tsx scripts/operator-action.ts recover-rate    <snapshotId> --reason=<CODE> [...]
 *   tsx scripts/operator-action.ts retire-anchor   <anchorSlug> --reason=<CODE> [...]
 *   tsx scripts/operator-action.ts reactivate-anchor <anchorSlug> --reason=<CODE> [...]
 */

type CommandName =
  | "invalidate-rate"
  | "reactivate-anchor"
  | "recover-rate"
  | "retire-anchor"
  | "supersede-rate";

const COMMANDS: ReadonlySet<string> = new Set<CommandName>([
  "invalidate-rate",
  "supersede-rate",
  "recover-rate",
  "retire-anchor",
  "reactivate-anchor",
]);

type ParsedArguments = Readonly<{
  positionals: readonly string[];
  values: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}>;

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0];
  if (command === undefined || !COMMANDS.has(command)) {
    return fail("UNKNOWN_COMMAND");
  }

  const parsed = parseArguments(rawArgs.slice(1));
  const target = parsed.positionals[0];
  if (target === undefined || target.trim().length === 0) {
    return fail("MISSING_TARGET");
  }

  const reasonCode = parsed.values.get("reason");
  if (reasonCode === undefined || !isOperatorReasonCode(reasonCode)) {
    return fail("MISSING_OR_INVALID_REASON");
  }

  const actor = parseActor(parsed.values.get("actor-id"));
  const mode = parsed.flags.has("apply") ? "apply" as const : "dry-run" as const;
  const base = {
    mode,
    actor,
    reasonCode,
    ...optional("rationale", parsed.values.get("rationale")),
    ...optional("runId", parsed.values.get("run-id")),
    ...optional("actionId", parsed.values.get("action-id")),
  };

  const result = await dispatch(command as CommandName, target.trim(), base);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "rejected") process.exitCode = 1;
}

async function dispatch(
  command: CommandName,
  target: string,
  base: BaseRequest,
): Promise<{ status: string }> {
  switch (command) {
    case "invalidate-rate":
    case "supersede-rate": {
      const disposition = command === "invalidate-rate" ? "INVALIDATED" : "SUPERSEDED";
      if (!isRateDispositionKind(disposition)) return { status: "rejected" };
      return runRateDisposition(
        { ...base, snapshotId: target, disposition },
        { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
      );
    }
    case "recover-rate":
      return runRateDispositionRecovery(
        { ...base, snapshotId: target },
        { repository: PRISMA_RATE_DISPOSITION_REPOSITORY },
      );
    case "retire-anchor":
      return runRegistryRetirement(
        { ...base, anchorSlug: target },
        { repository: PRISMA_REGISTRY_LIFECYCLE_REPOSITORY },
      );
    case "reactivate-anchor":
      return runRegistryReactivation(
        { ...base, anchorSlug: target },
        { repository: PRISMA_REGISTRY_LIFECYCLE_REPOSITORY },
      );
  }
}

type BaseRequest = Readonly<{
  mode: "dry-run" | "apply";
  actor: OperatorActor;
  reasonCode: OperatorReasonCode;
  rationale?: string;
  runId?: string;
  actionId?: string;
}>;

function optional<K extends string>(
  key: K,
  value: string | undefined,
): Partial<Record<K, string>> {
  return value === undefined ? {} : { [key]: value } as Record<K, string>;
}

function parseActor(raw: string | undefined): OperatorActor {
  const token = raw?.trim() ?? "";
  return token.length > 0
    ? Object.freeze({ kind: "human", id: token })
    : Object.freeze({ kind: "system" });
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (const arg of args) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const separator = body.indexOf("=");
    if (separator === -1) {
      flags.add(body);
    } else {
      values.set(body.slice(0, separator), body.slice(separator + 1));
    }
  }

  return Object.freeze({ positionals: Object.freeze(positionals), values, flags });
}

function fail(code: string): void {
  process.stdout.write(`${JSON.stringify({ status: "rejected", code })}\n`);
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main()
    .catch(() => {
      process.stderr.write(`${JSON.stringify({ status: "error", code: "OPERATOR_ACTION_FAILURE" })}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      const { db } = await import("@/lib/dbClient");
      await db.$disconnect().catch(() => undefined);
    });
}
