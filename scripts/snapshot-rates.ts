import "dotenv/config";

import { pathToFileURL } from "node:url";

import { createStructuredLogger } from "@/lib/scheduled/structuredLog";
import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";

export { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";

const logger = createStructuredLogger("snapshot-rates");

const PREPARATION_FAILURE_SUMMARY = Object.freeze({
  totalCandidates: 0,
  totalAttempted: 0,
  succeeded: 0,
  failed: 1,
  skipped: 0,
  snapshotsPersisted: 0,
  snapshots: [],
  failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
  skippedSources: [],
});

async function main(): Promise<void> {
  try {
    const summary = await snapshotReviewedLiveRates();
    logger.info("Reviewed rate snapshot run completed", { summary });
    if (summary.failed > 0) process.exitCode = 1;
  } catch {
    logger.error("Reviewed rate snapshot run failed", {
      code: "LIVE_RATE_PREPARATION_FAILURE",
      summary: PREPARATION_FAILURE_SUMMARY,
    });
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
