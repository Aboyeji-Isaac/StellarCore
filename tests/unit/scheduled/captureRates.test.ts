import assert from "node:assert/strict";
import test from "node:test";

import {
  RATE_CAPTURE_EXECUTION_BUDGET_MS,
  RATE_CAPTURE_SCHEDULE_CONTRACT,
  RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION,
} from "@/constants/scheduling";
import {
  runReviewedRateCapture,
  type RateCaptureCaptureOptions,
  type RateCaptureRunDependencies,
} from "@/lib/scheduled/captureRates";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type {
  CaptureRunCompletion,
  CaptureRunIdentity,
  CaptureScheduleAudit,
} from "@/types/scheduling";

const STARTED_AT = new Date("2026-08-31T16:00:00.000Z");

test("a disabled scheduler refuses to capture and touches nothing", async () => {
  const harness = captureHarness({ scheduler: "disabled" });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "disabled");
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CAPTURE_SCHEDULE_DISABLED");
  assert.equal(harness.captureCalls, 0);
  assert.equal(harness.lockAcquisitions, 0);
  assert.deepEqual(harness.startedRuns, []);
  assert.equal(result.rates.attempted, 0);
});

test("an incompatible checked-in cadence fails the invocation instead of capturing", async () => {
  const harness = captureHarness({ audit: incompatibleAudit() });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "INCOMPATIBLE_CAPTURE_SCHEDULE");
  assert.equal(harness.captureCalls, 0);
  assert.equal(harness.lockAcquisitions, 0);
});

test("a concurrent invocation acquires no lock, does no work, and writes no lineage", async () => {
  const harness = captureHarness({ lockAcquired: false });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "already_running");
  assert.equal(result.ok, true);
  assert.equal(result.errorCode, "ALREADY_RUNNING");
  assert.equal(result.runId, null);
  assert.equal(harness.captureCalls, 0);
  assert.deepEqual(harness.startedRuns, []);
  assert.deepEqual(harness.completedRuns, []);
});

test("an unavailable lock is reported truthfully and never silently ignored", async () => {
  const harness = captureHarness({ lockThrows: true });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "already_running");
  assert.equal(result.errorCode, "LOCK_UNAVAILABLE");
  assert.equal(harness.captureCalls, 0);
});

test("a lineage failure prevents all source work and still releases the lock", async () => {
  const harness = captureHarness({ failStartRun: true });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "CAPTURE_RUN_LINEAGE_FAILURE");
  assert.equal(result.lineageRecorded, false);
  assert.equal(harness.captureCalls, 0);
  assert.equal(harness.lockReleases, 1);
});

test("a healthy run links every persisted snapshot to its durable run identity", async () => {
  const harness = captureHarness();
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "completed");
  assert.equal(result.ok, true);
  assert.equal(result.lineageRecorded, true);
  assert.ok(result.runId);
  assert.equal(harness.lockAcquisitions, 1);
  assert.equal(harness.lockReleases, 1);

  const identity = harness.startedRuns[0]!;
  assert.equal(identity.runId, result.runId);
  assert.equal(identity.contractVersion, RATE_CAPTURE_SCHEDULE_CONTRACT_VERSION);
  assert.equal(identity.configurationFingerprint, "fingerprint-1");
  assert.equal(identity.scheduledIntervalMs, 60_000);
  assert.equal(identity.scheduler, "external");
  assert.equal(identity.startedAt.toISOString(), STARTED_AT.toISOString());
  assert.equal(identity.scheduledAt.toISOString(), STARTED_AT.toISOString());

  assert.deepEqual(harness.capturedSnapshotRunIds, [result.runId]);
  assert.equal(harness.completedRuns.length, 1);
  assert.equal(harness.completedRuns[0]!.outcome, "succeeded");
  assert.equal(harness.completedRuns[0]!.completedAt.toISOString(), STARTED_AT.toISOString());
  assert.deepEqual(harness.completedRuns[0]!.failureCodes, []);
  assert.equal(result.rates.succeeded, 1);
});

test("one failed reviewed source never erases a successful independent observation", async () => {
  const harness = captureHarness({
    summary: summary(null, {
      totalCandidates: 2,
      totalAttempted: 2,
      succeeded: 1,
      failed: 1,
      failures: Object.freeze([Object.freeze({
        anchorSlug: "zeam",
        corridorSlug: "usdc-us-brl-br",
        phase: "QUOTE" as const,
        code: "QUOTE_FAILURE",
      })]),
    }),
  });

  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "completed");
  assert.equal(result.ok, true);
  assert.equal(result.rates.succeeded, 1);
  assert.equal(result.rates.failed, 1);
  assert.deepEqual(result.rates.failures, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    phase: "QUOTE",
    code: "QUOTE_FAILURE",
  }]);
  assert.deepEqual(harness.completedRuns[0]!.failureCodes, ["QUOTE:QUOTE_FAILURE"]);
  assert.equal(harness.completedRuns[0]!.outcome, "partial");
  assert.equal(harness.completedRuns[0]!.succeeded, 1);
});

test("a run whose every reviewed source failed is reported as failed", async () => {
  const harness = captureHarness({
    summary: summary(null, {
      totalCandidates: 1,
      totalAttempted: 1,
      succeeded: 0,
      failed: 1,
      snapshotsPersisted: 0,
      snapshots: Object.freeze([]),
      failures: Object.freeze([Object.freeze({
        anchorSlug: "zeam",
        corridorSlug: "usdc-us-brl-br",
        phase: "PERSISTENCE" as const,
        code: "PERSISTENCE_FAILURE",
      })]),
    }),
  });

  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.ok, false);
  assert.equal(harness.completedRuns[0]!.outcome, "failed");
  assert.equal(result.rates.succeeded, 0);
});

test("a fatal preparation failure is sanitized, releases the lock, and records a failed run", async () => {
  const harness = captureHarness({ captureThrows: true });
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.state, "completed");
  assert.equal(result.ok, false);
  assert.equal(result.rates.failed, 1);
  assert.equal(harness.lockReleases, 1);
  assert.deepEqual(harness.completedRuns[0]!.failureCodes, ["LIVE_RATE_PREPARATION_FAILURE"]);
  assert.equal(harness.completedRuns[0]!.outcome, "failed");
  assert.equal(JSON.stringify(result).includes("DATABASE_URL"), false);
});

test("the bounded execution budget closes the source gate at the documented deadline", async () => {
  const harness = captureHarness();
  await runReviewedRateCapture(harness.dependencies);

  const gate = harness.capturedOptions!.shouldContinue;
  const offset = (ms: number) => new Date(STARTED_AT.getTime() + ms);

  harness.setNow(STARTED_AT);
  assert.equal(gate(), true);
  harness.setNow(offset(RATE_CAPTURE_EXECUTION_BUDGET_MS - 1));
  assert.equal(gate(), true);
  harness.setNow(offset(RATE_CAPTURE_EXECUTION_BUDGET_MS));
  assert.equal(gate(), false);
  harness.setNow(offset(RATE_CAPTURE_SCHEDULE_CONTRACT.executionBudgetMs * 10));
  assert.equal(gate(), false);
});

test("a source skipped for budget exhaustion is reported as skipped, never as an observation", async () => {
  const harness = captureHarness({
    summary: summary(null, {
      totalCandidates: 2,
      totalAttempted: 1,
      succeeded: 1,
      failed: 0,
      skipped: 1,
      skippedSources: Object.freeze([Object.freeze({
        anchorSlug: "other-anchor",
        corridorSlug: "usdc-us-brl-br",
        reason: "EXECUTION_BUDGET_EXHAUSTED" as const,
      })]),
    }),
  });

  const result = await runReviewedRateCapture(harness.dependencies);

  assert.equal(result.ok, true);
  assert.equal(result.rates.skipped, 1);
  assert.equal(result.rates.failed, 0);
  assert.deepEqual(result.rates.skippedSources, [{
    anchorSlug: "other-anchor",
    corridorSlug: "usdc-us-brl-br",
    reason: "EXECUTION_BUDGET_EXHAUSTED",
  }]);
  assert.equal(harness.completedRuns[0]!.outcome, "partial");
  assert.equal(harness.completedRuns[0]!.skipped, 1);
});

test("the capture boundary is not the reputation boundary", async () => {
  const harness = captureHarness();
  const result = await runReviewedRateCapture(harness.dependencies);

  assert.deepEqual(Object.keys(result).sort(), [
    "completedAt",
    "configurationFingerprint",
    "contractVersion",
    "errorCode",
    "lineageRecorded",
    "ok",
    "rates",
    "runId",
    "scheduledIntervalMs",
    "scheduler",
    "startedAt",
    "state",
  ]);
  assert.equal("reputation" in result, false);
  assert.equal("median" in result, false);
});

function captureHarness(overrides: {
  scheduler?: "vercel-cron" | "external" | "disabled";
  audit?: CaptureScheduleAudit;
  lockAcquired?: boolean;
  lockThrows?: boolean;
  failStartRun?: boolean;
  captureThrows?: boolean;
  summary?: SafeLiveRateRunSummary;
} = {}) {
  const startedRuns: CaptureRunIdentity[] = [];
  const completedRuns: CaptureRunCompletion[] = [];
  const capturedSnapshotRunIds: Array<string | null> = [];
  let captureCalls = 0;
  let lockAcquisitions = 0;
  let lockReleases = 0;
  let capturedOptions: RateCaptureCaptureOptions | null = null;
  let clock = STARTED_AT;

  const dependencies: RateCaptureRunDependencies = Object.freeze({
    capture: async (options: RateCaptureCaptureOptions) => {
      captureCalls += 1;
      capturedOptions = options;
      capturedSnapshotRunIds.push(options.lineage.captureRunId ?? null);
      if (overrides.captureThrows) throw new Error("DATABASE_URL=should-not-leak");
      return overrides.summary ?? summary(options.lineage.captureRunId ?? null);
    },
    lock: Object.freeze({
      async acquire() {
        lockAcquisitions += 1;
        if (overrides.lockThrows) throw new Error("lock unavailable");
        if (overrides.lockAcquired === false) {
          return Object.freeze({ acquired: false as const, reason: "ALREADY_RUNNING" as const });
        }
        return Object.freeze({
          acquired: true as const,
          release: async () => { lockReleases += 1; },
        });
      },
    }),
    lineage: Object.freeze({
      async startRun(input: CaptureRunIdentity) {
        if (overrides.failStartRun) throw new Error("lineage unavailable");
        startedRuns.push(input);
      },
      async completeRun(input: CaptureRunCompletion) {
        completedRuns.push(input);
      },
      async findLatestCompletedScheduledRun() {
        return null;
      },
    }),
    scheduler: () => overrides.scheduler ?? "external",
    auditSchedule: () => overrides.audit ?? okAudit(),
    configurationFingerprint: () => "fingerprint-1",
    now: () => clock,
  });

  return {
    dependencies,
    startedRuns,
    completedRuns,
    capturedSnapshotRunIds,
    setNow: (value: Date) => { clock = value; },
    get captureCalls() { return captureCalls; },
    get lockAcquisitions() { return lockAcquisitions; },
    get lockReleases() { return lockReleases; },
    get capturedOptions() { return capturedOptions; },
  };
}

function okAudit(intervalMs = 60_000): CaptureScheduleAudit {
  return Object.freeze({
    ok: true,
    contract: RATE_CAPTURE_SCHEDULE_CONTRACT,
    selectedScheduler: "external",
    intervalMs,
    issues: Object.freeze([]),
  });
}

function incompatibleAudit(): CaptureScheduleAudit {
  return Object.freeze({
    ok: false,
    contract: RATE_CAPTURE_SCHEDULE_CONTRACT,
    selectedScheduler: "external",
    intervalMs: 300_000,
    issues: Object.freeze([Object.freeze({
      code: "CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET" as const,
      severity: "error" as const,
      detail: "cadence does not fit",
    })]),
  });
}

function summary(
  captureRunId: string | null,
  overrides: Partial<SafeLiveRateRunSummary> = {},
): SafeLiveRateRunSummary {
  const base: SafeLiveRateRunSummary = Object.freeze({
    totalCandidates: 1,
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    snapshotsPersisted: 1,
    snapshots: Object.freeze([Object.freeze({
      id: "snapshot-1",
      anchorSlug: "zeam",
      corridorSlug: "usdc-us-brl-br",
      rate: "0.17",
      capturedAt: STARTED_AT.toISOString(),
      captureRunId,
    })]),
    failures: Object.freeze([]),
    skippedSources: Object.freeze([]),
  });
  return Object.freeze(Object.assign({}, base, overrides));
}
