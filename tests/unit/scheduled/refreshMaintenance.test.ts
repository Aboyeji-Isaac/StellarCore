import assert from "node:assert/strict";
import test from "node:test";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function rateSummary(): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 1,
    snapshots: Object.freeze([]),
    failures: Object.freeze([]),
    skippedSources: Object.freeze([]),
  });
}

test("active maintenance blocks scheduled writes before rate/reputation work", async () => {
  let rates = 0;
  let reputation = 0;

  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      rates += 1;
      return rateSummary();
    },
    evaluateReputation: async () => {
      reputation += 1;
      return Object.freeze({
        attempted: 1,
        succeeded: 1,
        failed: 0,
        failures: Object.freeze([]),
      });
    },
    checkMaintenance: async () =>
      Object.freeze({
        ok: false as const,
        error: Object.freeze({
          code: "MAINTENANCE_MODE_ACTIVE" as const,
          message: "Maintenance mode is active; evidence mutations are blocked.",
        }),
      }),
    now: () => NOW,
  });

  assert.equal(rates, 0);
  assert.equal(reputation, 0);
  assert.equal(result.ok, false);
  assert.equal(result.rates.failures[0]?.phase, "MAINTENANCE");
  assert.equal(result.rates.failures[0]?.code, "MAINTENANCE_MODE_ACTIVE");
});

test("unreadable maintenance state fails safe before scheduled work", async () => {
  let invoked = false;
  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      invoked = true;
      return rateSummary();
    },
    evaluateReputation: async () => {
      invoked = true;
      return Object.freeze({
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failures: Object.freeze([]),
      });
    },
    checkMaintenance: async () =>
      Object.freeze({
        ok: false as const,
        error: Object.freeze({
          code: "MAINTENANCE_STATE_UNAVAILABLE" as const,
          message: "Maintenance state is unavailable.",
        }),
      }),
    now: () => NOW,
  });
  assert.equal(invoked, false);
  assert.equal(result.rates.failures[0]?.code, "MAINTENANCE_STATE_UNAVAILABLE");
});
