import "dotenv/config";

import { pathToFileURL } from "node:url";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import {
  createPrismaRefreshRunStore,
  type RefreshRunRecord,
} from "@/lib/scheduled/refreshRunRepository";

const USAGE = `Usage: npm run refresh:runs -- <command> [argument]

Commands:
  list [limit]     Print recent runs (default limit 20, max 100)
  show <runId>     Print one run's persisted state, phases, and failures
  resume <runId>   Safely retry a FAILED or PARTIALLY_SUCCEEDED run

Inspection is read-only. resume acquires the advisory lock and runs only the
phases that did not already succeed, carrying forward persisted successes.
`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, argument] = argv;
  const runs = createPrismaRefreshRunStore();

  if (command === "list") {
    const parsed = argument === undefined ? 20 : Number.parseInt(argument, 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
    const records = await runs.listRecent(limit);
    write({ runs: records.map(toSummary) });
    return;
  }

  if (command === "show") {
    if (argument === undefined) throw new Error("show requires a run id");
    const record = await runs.get(argument);
    write({ run: record });
    if (record === null) process.exitCode = 1;
    return;
  }

  if (command === "resume") {
    if (argument === undefined) throw new Error("resume requires a run id");
    const result = await runScheduledRefresh(undefined, { resumeRunId: argument });
    write(result);
    if (result.state !== "succeeded") process.exitCode = 1;
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 1;
}

function toSummary(record: RefreshRunRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: record.id,
    state: record.state,
    attempt: record.attempt,
    resumedFromId: record.resumedFromId,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    phases: Object.fromEntries(
      Object.entries(record.phases).map(([phase, progress]) => [phase, progress.state]),
    ),
    failures: record.failures,
  });
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "refresh:runs failed"}\n`);
    process.exitCode = 1;
  });
}
