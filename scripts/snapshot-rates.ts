import "dotenv/config";

import { pathToFileURL } from "node:url";

import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";

export { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";

async function main(): Promise<void> {
  try {
    const summary = await snapshotReviewedLiveRates();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed > 0) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      totalCandidates: 0,
      totalAttempted: 0,
      succeeded: 0,
      failed: 1,
      skipped: 0,
      snapshotsPersisted: 0,
      snapshots: [],
      failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
      skippedSources: [],
    })}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
