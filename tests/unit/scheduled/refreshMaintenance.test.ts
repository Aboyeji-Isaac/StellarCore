import assert from "node:assert/strict";
import test from "node:test";

import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ScheduledRefreshDependencies } from "@/lib/scheduled/refresh";

const STARTED_AT = new Date("2026-08-31T16:00:00.000Z");

function rateSummary(overrides: Partial<SafeLiveRateRunSummary> = {}): SafeLiveRateRunSummary {
  return Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 1,
    snapshots: [],
    failures: [],
    skippedSources: [],
    ...overrides,
  });
}

function reputationSummary(overrides: Record<string, unknown> = {}) {
  return Object.freeze({
    attempted: 3,
    succeeded: 3,
    failed: 0,
    failures: [],
    ...overrides,
  }) as Awaited<ReturnType<ScheduledRefreshDependencies["evaluateReputation"]>>;
}

function maintenanceCheckOk() {
  return async () => ({ ok: true as const, value: undefined });
}

function maintenanceCheckBlocked(code: string) {
  return async () => ({
    ok: false as const,
    error: { code, message: "Maintenance mode is active; evidence mutations are blocked." },
  });
}

test("scheduled refresh runs normally when maintenance is inactive", async () => {
  let rateRuns = 0;
  let reputationRuns = 0;
  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      rateRuns += 1;
      return rateSummary();
    },
    evaluateReputation: async () => {
      reputationRuns += 1;
      return reputationSummary();
    },
    now: () => STARTED_AT,
    checkMaintenance: maintenanceCheckOk(),
  });

  assert.equal(rateRuns, 1);
  assert.equal(reputationRuns, 1);
  assert.equal(result.ok, true);
  assert.equal(result.rates.succeeded, 1);
  assert.equal(result.reputation.succeeded, 3);
});

test("scheduled refresh blocks rate ingestion and reputation when maintenance is active", async () => {
  let rateRuns = 0;
  let reputationRuns = 0;
  const result = await runScheduledRefresh({
    snapshotRates: async () => {
      rateRuns += 1;
      return rateSummary();
    },
    evaluateReputation: async () => {
      reputationRuns += 1;
      return reputationSummary();
    },
    now: () => STARTED_AT,
    checkMaintenance: maintenanceCheckBlocked("MAINTENANCE_MODE_ACTIVE"),
  });

  assert.equal(rateRuns, 0);
  assert.equal(reputationRuns, 0);
  assert.equal(result.ok, false);
  assert.equal(result.rates.failed, 1);
  assert.equal(result.rates.failures[0]?.phase, "MAINTENANCE");
  assert.equal(result.rates.failures[0]?.code, "MAINTENANCE_MODE_ACTIVE");
  assert.equal(result.reputation.failed, 1);
  assert.equal(result.reputation.failures[0]?.code, "MAINTENANCE_MODE_ACTIVE");
});

test("scheduled refresh blocks with MAINTENANCE_STATE_UNAVAILABLE when check fails safe", async () => {
  const result = await runScheduledRefresh({
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => reputationSummary(),
    now: () => STARTED_AT,
    checkMaintenance: maintenanceCheckBlocked("MAINTENANCE_STATE_UNAVAILABLE"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.rates.failures[0]?.code, "MAINTENANCE_STATE_UNAVAILABLE");
  assert.equal(result.reputation.failures[0]?.code, "MAINTENANCE_STATE_UNAVAILABLE");
});

test("scheduled refresh returns frozen result when maintenance blocks", async () => {
  const result = await runScheduledRefresh({
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => reputationSummary(),
    now: () => STARTED_AT,
    checkMaintenance: maintenanceCheckBlocked("MAINTENANCE_MODE_ACTIVE"),
  });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rates), true);
  assert.equal(Object.isFrozen(result.reputation), true);
  assert.doesNotThrow(() => JSON.stringify(result));
});