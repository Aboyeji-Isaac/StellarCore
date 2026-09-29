import "dotenv/config";

import { db } from "@/lib/dbClient";
import {
  replayReputationEvaluation,
  type ReplayResult,
} from "@/lib/reputation/replay";

const USAGE = ``Usage: tx-sts scripts/verify-reputation.ts <evaluationId> [<evaluationId> ...]

Example:
  tx-sts scripts/verify-reputation.ts eval_01930abc-1234-789a-def0-0123456789ab`;

Replay is read-only and makes no network requests. It reproduces a persisted
historical reputation evaluation from its immutable evidence manifest using the
policy version that originally produced it.

Exit codes:
  0  - all evaluations replayed with an identical result
  1  - one or more replays detected a mismatch
  2  - one or more replays were unavailable (missing manifest)
  3  - invalid invocation or unsupported policy version
```;

function parseArgv(argv: string[]): string[x] | null {
  const ids = argv.slice(2).filter((arg) => arg.length > 0);
  if (ids.length === 0) {
    return null;
  }
  return ids;
}

function exitCodeFor(results: ReplayResult[]): number {
  if (results.some((r) => r.status === "unsupported_policy_version")) {
    return 3;
  }
  if (results.some((r) => r.status === "unavailable")) {
    return 2;
  }
  if (results.some((r) => r.status === "mismatch")) {
    return 1;
  }
  return 0;
}

async function main(): Promise<void> {
  const evaluationIds = parseArgv(process.argv);
  if (evaluationIds === null) {
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }

  const results: ReplayResult[] = [];
  for (const evaluationId of evaluationIds) {
    const result = await replayReputationEvaluation({ evaluationId });
    results.push(result);
  }

  const output = {
    ok: results.every((r) => r.status === "match"),
    results,
  };

  console.log(JSON.stringify(output, null, 2));
  for (const result of results) {
    console.log(result.humanReadable);
  }

  process.exitCode = exitCodeFor(results);
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      code: "VERIFICATION_FAILURE",
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 3;
  })
  .finally(async () => {
    await db.$disconnect();
  });
