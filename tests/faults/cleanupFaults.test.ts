/**
 * Cleanup-failure fault injection for the scheduled workflow boundary.
 *
 * The scheduled refresh owns one cleanup boundary: the advisory-lock client
 * returns the PostgreSQL session lock and the pooled connection after the
 * cycle. These tests inject controlled failures into the operation and into
 * both cleanup steps, then assert:
 *
 * 1. the primary workflow failure stays identifiable — a cleanup exception
 *    never replaces it;
 * 2. cleanup failures are recorded through a sanitized descriptor and never
 *    turn a failed cycle into a success, nor a failed release into a reported
 *    success;
 * 3. cleanup continues where safe: a failed unlock still returns the
 *    connection, and a throwing reporter never stops cleanup;
 * 4. no exception content (credentials, connection strings, query text) leaks
 *    into the public HTTP boundary or the recorded diagnostics.
 *
 * Everything is offline and deterministic: faults are injected through the
 * existing dependency seams, with no database, network, timers, or scheduler.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";

import {
  AdvisoryLockCleanupError,
  withAdvisoryLock,
  type AdvisoryLockCleanupFailure,
  type AdvisoryLockClientDependencies,
} from "@/lib/scheduled/advisoryLockClient";
import { LOCK_REGISTRY } from "@/lib/scheduled/advisoryLockKey";
import { getScheduledRefreshResponse } from "@/lib/scheduled/http";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { ReputationEvaluationRunSummary } from "@/lib/reputation/run";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ScheduledRefreshResult } from "@/types/scheduled";
import { InjectedFaultError } from "./faultKit.js";

const LOCK_KEY = LOCK_REGISTRY.find(
  (entry) => entry.logicalName === "refresh:scheduled-refresh:v1:global",
)!.derivedKey;

const EVALUATED_AT = new Date("2026-09-30T00:00:00.000Z");
const CRON_SECRET = "local-test-cron-secret";
/** Credential-bearing text that must never cross a public or logged boundary. */
const SENSITIVE = "postgresql://stellarcore:hunter2@db.internal:5432/stellarcore";

const RATE_SUMMARY: SafeLiveRateRunSummary = Object.freeze({
  totalCandidates: 1,
  totalAttempted: 1,
  succeeded: 1,
  failed: 0,
  skipped: 0,
  suppressed: 0,
  snapshotsPersisted: 1,
  snapshots: Object.freeze([]),
  failures: Object.freeze([]),
  skippedSources: Object.freeze([]),
});

const REPUTATION_SUMMARY: ReputationEvaluationRunSummary = Object.freeze({
  attempted: 2,
  succeeded: 2,
  failed: 0,
  failures: Object.freeze([]),
});

type HarnessOptions = Readonly<{
  acquired?: boolean;
  failAcquire?: boolean;
  failUnlock?: boolean;
  failRelease?: boolean;
  reporterThrows?: boolean;
}>;

type Harness = Readonly<{
  deps: AdvisoryLockClientDependencies;
  events: string[];
  recorded: AdvisoryLockCleanupFailure[];
  releaseCalls: () => number;
}>;

function client(options: HarnessOptions, events: string[]): PoolClient {
  return {
    query: async (sql: string) => {
      if (/pg_try_advisory_lock/.test(sql)) {
        if (options.failAcquire) {
          events.push("acquire-failed");
          throw new Error(`acquire failed: ${SENSITIVE}`);
        }
        return { rows: [{ acquired: options.acquired ?? true }] };
      }
      if (options.failUnlock) {
        events.push("unlock-failed");
        throw new Error(`unlock failed: ${SENSITIVE}`);
      }
      events.push("unlock");
      return { rows: [{ pg_advisory_unlock: true }] };
    },
    release: () => undefined,
  } as unknown as PoolClient;
}

function harness(options: HarnessOptions = {}): Harness {
  const events: string[] = [];
  const recorded: AdvisoryLockCleanupFailure[] = [];
  let releases = 0;

  const deps: AdvisoryLockClientDependencies = {
    checkoutClient: async () => client(options, events),
    releaseClient: () => {
      releases += 1;
      events.push(options.failRelease ? "release-failed" : "release");
      if (options.failRelease) throw new Error(`release failed: ${SENSITIVE}`);
    },
    reportCleanupFailure: (failure) => {
      recorded.push(failure);
      events.push(`report:${failure.step}`);
      if (options.reporterThrows) throw new Error(`reporter failed: ${SENSITIVE}`);
    },
  };

  return Object.freeze({
    deps,
    events,
    recorded,
    releaseCalls: () => releases,
  });
}

function refreshDependencies(
  overrides: Readonly<{ failReputationWith?: Error }> = {},
) {
  return {
    snapshotRates: async () => RATE_SUMMARY,
    evaluateReputation: async () => {
      if (overrides.failReputationWith) throw overrides.failReputationWith;
      return REPUTATION_SUMMARY;
    },
    now: () => EVALUATED_AT,
  };
}

/**
 * Mirrors the production wiring: the HTTP route receives only the bounded run
 * summary, never the lock descriptor (which carries a bigint key).
 */
async function runCycleUnderLock(
  fault: Harness,
  overrides: Readonly<{ failReputationWith?: Error }> = {},
): Promise<ScheduledRefreshResult> {
  const outcome = await withAdvisoryLock(
    LOCK_KEY,
    () => runScheduledRefresh(refreshDependencies(overrides)),
    fault.deps,
  );
  if (!("result" in outcome)) throw new Error("test expected the lock to be acquired");
  return outcome.result;
}

function cronRequest(): Request {
  return new Request("https://stellarcore.test/api/internal/cron/refresh", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

function assertNoSensitiveContent(value: unknown): void {
  assert.equal(
    JSON.stringify(value).includes("hunter2"),
    false,
    `sensitive content leaked into: ${JSON.stringify(value)}`,
  );
}

// ---------------------------------------------------------------------------
// 1. The primary failure survives combined operation and cleanup failures
// ---------------------------------------------------------------------------

test("[C1] the primary failure survives when unlock and release both throw", async () => {
  const primary = new InjectedFaultError("PRIMARY_RATE_SOURCE_FAILURE");
  const fault = harness({ failUnlock: true, failRelease: true });

  await assert.rejects(
    withAdvisoryLock(LOCK_KEY, async () => {
      throw primary;
    }, fault.deps),
    (error) => error === primary,
    "the cleanup exception must not replace the primary workflow failure",
  );

  assert.deepEqual(fault.recorded, [
    { step: "UNLOCK", code: "UNLOCK_FAILURE" },
    { step: "RELEASE", code: "RELEASE_FAILURE" },
  ]);
  assert.deepEqual(fault.events, [
    "unlock-failed",
    "report:UNLOCK",
    "release-failed",
    "report:RELEASE",
  ]);
  assert.equal(fault.releaseCalls(), 1, "release is still attempted after a failed unlock");
  assertNoSensitiveContent(fault.recorded);
});

test("[C2] a failing acquire step is preserved when cleanup also throws", async () => {
  const fault = harness({ failAcquire: true, failRelease: true });

  await assert.rejects(
    withAdvisoryLock(LOCK_KEY, async () => "never-runs", fault.deps),
    /acquire failed/,
    "the acquire failure must survive a failing release",
  );

  assert.deepEqual(fault.recorded, [{ step: "RELEASE", code: "RELEASE_FAILURE" }]);
  assert.equal(fault.releaseCalls(), 1);
  assertNoSensitiveContent(fault.recorded);
});

// ---------------------------------------------------------------------------
// 2. Cleanup continues where safe after an individual cleanup step fails
// ---------------------------------------------------------------------------

test("[C3] a failed unlock still returns the connection and records the failure", async () => {
  const fault = harness({ failUnlock: true });

  const outcome = await withAdvisoryLock(LOCK_KEY, async () => "cycle-complete", fault.deps);

  assert.ok("result" in outcome);
  assert.equal(outcome.result, "cycle-complete");
  assert.equal(fault.releaseCalls(), 1, "cleanup must continue past the failed unlock");
  assert.deepEqual(fault.events, ["unlock-failed", "report:UNLOCK", "release"]);
  assert.deepEqual(fault.recorded, [{ step: "UNLOCK", code: "UNLOCK_FAILURE" }]);
});

test("[C4] a throwing cleanup reporter never stops cleanup or masks the failure", async () => {
  const primary = new InjectedFaultError("PRIMARY_REPUTATION_FAILURE");
  const fault = harness({ failUnlock: true, failRelease: true, reporterThrows: true });

  await assert.rejects(
    withAdvisoryLock(LOCK_KEY, async () => {
      throw primary;
    }, fault.deps),
    (error) => error === primary,
  );

  assert.equal(fault.releaseCalls(), 1);
  assert.deepEqual(fault.recorded, [
    { step: "UNLOCK", code: "UNLOCK_FAILURE" },
    { step: "RELEASE", code: "RELEASE_FAILURE" },
  ]);
});

// ---------------------------------------------------------------------------
// 3. Cleanup failures are recorded and never reported as success
// ---------------------------------------------------------------------------

test("[C5] a failed release rejects with a bounded cleanup error instead of success", async () => {
  const fault = harness({ failRelease: true });

  await assert.rejects(
    withAdvisoryLock(LOCK_KEY, async () => "must-not-surface", fault.deps),
    (error) => {
      assert.ok(error instanceof AdvisoryLockCleanupError);
      assert.equal(error.name, "AdvisoryLockCleanupError");
      assert.equal(error.code, "CLEANUP_FAILURE");
      assert.equal(error.step, "RELEASE");
      assert.equal(error.message, "Advisory lock cleanup failed");
      assert.deepEqual(error.failures, [{ step: "RELEASE", code: "RELEASE_FAILURE" }]);
      assert.equal(
        JSON.stringify({
          name: error.name,
          message: error.message,
          code: error.code,
          failures: error.failures,
        }).includes("hunter2"),
        false,
        "the cleanup error must stay bounded",
      );
      return true;
    },
  );

  assert.deepEqual(fault.recorded, [{ step: "RELEASE", code: "RELEASE_FAILURE" }]);
});

// ---------------------------------------------------------------------------
// 4. The public boundary stays sanitized and never reports false success
// ---------------------------------------------------------------------------

test("[C6] a scheduled cycle with a failed operation and failed cleanup returns a safe 500", async () => {
  const primary = new Error(`reputation evidence store unavailable: ${SENSITIVE}`);
  const fault = harness({ failUnlock: true, failRelease: true });
  let observed: unknown;

  const response = await getScheduledRefreshResponse(cronRequest(), {
    cronSecret: CRON_SECRET,
    run: async () => {
      try {
        return await runCycleUnderLock(fault, { failReputationWith: primary });
      } catch (error) {
        observed = error;
        throw error;
      }
    },
  });

  assert.equal(observed, primary, "the primary failure remains the surfaced error");
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.deepEqual(body, {
    error: { code: "internal_error", message: "Unable to run scheduled refresh." },
  });
  assertNoSensitiveContent(body);
  assertNoSensitiveContent(fault.recorded);
});

test("[C7] a successful cycle whose cleanup release fails is never reported as success", async () => {
  const fault = harness({ failRelease: true });

  const response = await getScheduledRefreshResponse(cronRequest(), {
    cronSecret: CRON_SECRET,
    run: () => runCycleUnderLock(fault),
  });

  assert.equal(response.status, 500, "cleanup failure must not become a 200 success");
  const body = await response.json();
  assert.deepEqual(body, {
    error: { code: "internal_error", message: "Unable to run scheduled refresh." },
  });
  assert.deepEqual(fault.recorded, [{ step: "RELEASE", code: "RELEASE_FAILURE" }]);
  assertNoSensitiveContent(body);
});

test("[C8] the successful sanitized result is returned when only the unlock fails", async () => {
  const fault = harness({ failUnlock: true });

  const response = await getScheduledRefreshResponse(cronRequest(), {
    cronSecret: CRON_SECRET,
    run: () => runCycleUnderLock(fault),
  });

  assert.equal(response.status, 200, "a lost session releases its advisory lock automatically");
  const body = await response.json() as ScheduledRefreshResult;
  assert.equal(body.ok, true);
  assert.equal(body.rates.succeeded, 1);
  assert.deepEqual(fault.recorded, [{ step: "UNLOCK", code: "UNLOCK_FAILURE" }]);
  assertNoSensitiveContent(body);
});
