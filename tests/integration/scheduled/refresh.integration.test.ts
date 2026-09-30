import assert from "node:assert/strict";
import test from "node:test";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import { createFakeLockProvider, createInMemoryRefreshRunStore } from "@/tests/unit/scheduled/refreshHarness";

const EVALUATED_AT = new Date("2026-08-31T17:00:00.000Z");

test("controlled scheduled integration passes one persisted evaluation time from rate ingestion to reputation and records both phases", async () => {
  const events: string[] = [];
  const { store, rows } = createInMemoryRefreshRunStore();
  const { provider, state: lockState } = createFakeLockProvider();
  const clock = () => new Date(EVALUATED_AT.getTime() + events.length * 1_000);

  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      events.push("rate-persisted");
      return {
        totalCandidates: 1,
        totalAttempted: 1,
        succeeded: 1,
        failed: 0,
        skipped: 0,
        snapshotsPersisted: 1,
        snapshots: [],
        failures: [],
        skippedSources: [],
      };
    },
    evaluateReputation: async ({ evaluatedAt }) => {
      events.push(`reputation:${evaluatedAt.toISOString()}`);
      return { attempted: 2, succeeded: 2, failed: 0, failures: [] };
    },
    now: clock,
    newRunId: () => "integration-run-1",
    lock: provider,
    runs: store,
    log: () => {},
  });

  assert.deepEqual(events, ["rate-persisted", "reputation:2026-08-31T17:00:00.000Z"]);
  assert.equal(result.ok, true);
  assert.equal(result.state, "succeeded");
  assert.equal(result.rates.succeeded, 1);
  assert.equal(result.reputation.succeeded, 2);
  assert.equal(lockState.releases, 1);

  const [record] = rows();
  assert.equal(record?.id, "integration-run-1");
  assert.equal(record?.state, "SUCCEEDED");
  assert.equal(record?.phases.rates.state, "SUCCEEDED");
  assert.equal(record?.phases.reputation.state, "SUCCEEDED");
  assert.equal(record?.completedAt, result.completedAt);
});
