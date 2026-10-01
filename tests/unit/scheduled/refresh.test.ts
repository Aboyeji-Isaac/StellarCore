import assert from "node:assert/strict";
import test from "node:test";

import { runScheduledRefresh, RefreshRunNotResumableError, type ScheduledRefreshDependencies } from "@/lib/scheduled/refresh";
import type { RefreshRunLogEvent } from "@/lib/scheduled/refreshLog";
import type { RefreshRunRecord, RefreshRunStore } from "@/lib/scheduled/refreshRunRepository";
import type { ScheduledRefreshResult } from "@/types/scheduled";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

import { createFakeLockProvider, createInMemoryRefreshRunStore } from "./refreshHarness";

const STARTED_AT = new Date("2026-08-31T16:00:00.000Z");

test("scheduled refresh locks, persists a durable run, runs rates before reputation, and reports truthful success", async () => {
  const harness = createHarness({
    snapshotRates: async () => {
      harness.order.push("rates");
      return rateSummary();
    },
    evaluateReputation: async ({ evaluatedAt }) => {
      harness.order.push(`reputation:${evaluatedAt.toISOString()}`);
      return reputationSummary();
    },
  });

  const result = await runScheduledRefresh(harness.deps);

  assert.deepEqual(harness.order, ["rates", "reputation:2026-08-31T16:00:00.000Z"]);
  assert.equal(result.ok, true);
  assert.equal(result.state, "succeeded");
  assert.equal(result.runId, "run-1");
  assert.equal(result.resumedFromId, null);
  assert.equal(result.activeRunId, null);
  assert.equal(result.startedAt, STARTED_AT.toISOString());
  assert.deepEqual(result.rates, { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] });
  assert.deepEqual(result.reputation, { attempted: 3, succeeded: 3, failed: 0, failures: [] });
  assert.equal(harness.lock.state.acquires, 1);
  assert.equal(harness.lock.state.releases, 1);

  const [record] = harness.rows();
  assert.equal(record?.state, "SUCCEEDED");
  assert.equal(record?.completedAt, result.completedAt);
  assert.equal(record?.phases.rates.state, "SUCCEEDED");
  assert.equal(record?.phases.reputation.state, "SUCCEEDED");
  assert.deepEqual(record?.failures, []);
  assert.equal(record?.result?.runId, "run-1");
  assert.ok(harness.events.some(({ event }) => event === "refresh_run_completed"));
});

test("a rate source failure is distinguished from complete success while reputation still evaluates persisted evidence", async () => {
  let evaluated = false;
  const harness = createHarness({
    snapshotRates: async () => rateSummary({
      succeeded: 0,
      failed: 1,
      snapshotsPersisted: 0,
      failures: [{ anchorSlug: "zeam", corridorSlug: "usdc-us-brl-br", phase: "QUOTE", code: "QUOTE_FAILURE" }],
    }),
    evaluateReputation: async () => {
      evaluated = true;
      return reputationSummary();
    },
  });

  const result = await runScheduledRefresh(harness.deps);

  assert.equal(evaluated, true);
  assert.equal(result.ok, false);
  assert.equal(result.state, "partially_succeeded");
  assert.deepEqual(result.rates.failures, [{
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
    phase: "QUOTE",
    code: "QUOTE_FAILURE",
  }]);
  const [record] = harness.rows();
  assert.equal(record?.state, "PARTIALLY_SUCCEEDED");
  assert.equal(record?.phases.rates.state, "FAILED");
  assert.equal(record?.phases.reputation.state, "SUCCEEDED");
  assert.deepEqual(record?.failures, [{
    phase: "rates",
    code: "QUOTE_FAILURE",
    anchorSlug: "zeam",
    corridorSlug: "usdc-us-brl-br",
  }]);
});

test("a rate preparation failure is safely serialized, does not abort reputation, and never leaks the thrown message", async () => {
  let evaluated = false;
  const harness = createHarness({
    snapshotRates: async () => {
      throw new Error("DATABASE_URL=should-not-leak");
    },
    evaluateReputation: async () => {
      evaluated = true;
      return reputationSummary();
    },
  });

  const result = await runScheduledRefresh(harness.deps);

  assert.equal(evaluated, true);
  assert.equal(result.ok, false);
  assert.equal(result.state, "partially_succeeded");
  assert.deepEqual(result.rates, {
    attempted: 0,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    failures: [{ phase: "PREPARATION", code: "LIVE_RATE_PREPARATION_FAILURE" }],
  });
  assert.equal(JSON.stringify(result).includes("should-not-leak"), false);
  assert.equal(JSON.stringify(harness.rows()).includes("should-not-leak"), false);
});

test("a fatal reputation orchestration failure terminalizes the run, releases the lock, and still reaches the HTTP boundary", async () => {
  const harness = createHarness({
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => {
      throw new Error("database unavailable at postgres://secret");
    },
  });

  await assert.rejects(runScheduledRefresh(harness.deps));

  const [record] = harness.rows();
  assert.equal(record?.state, "PARTIALLY_SUCCEEDED");
  assert.equal(record?.phases.rates.state, "SUCCEEDED");
  assert.equal(record?.phases.reputation.state, "FAILED");
  assert.deepEqual(record?.failures, [{ phase: "reputation", code: "REPUTATION_ORCHESTRATION_FAILURE", anchorSlug: "orchestration" }]);
  assert.equal(JSON.stringify(record?.result).includes("secret"), false);
  assert.equal(harness.lock.state.releases, 1);
});

test("an unavailable advisory lock returns already_running without starting phases or writing a run", async () => {
  const harness = createHarness({}, { lock: "unavailable" });
  const active = await harness.store.create({
    id: "active-run",
    triggeredBy: "cron",
    attempt: 1,
    startedAt: STARTED_AT,
  });
  let phaseWork = 0;

  const result = await runScheduledRefresh({
    ...harness.deps,
    snapshotRates: async () => { phaseWork += 1; return rateSummary(); },
    evaluateReputation: async () => { phaseWork += 1; return reputationSummary(); },
  });

  assert.equal(result.state, "already_running");
  assert.equal(result.ok, true);
  assert.equal(result.activeRunId, active.id);
  assert.notEqual(result.runId, active.id);
  assert.equal(phaseWork, 0);
  assert.equal(harness.rows().length, 1);
  assert.equal(harness.lock.state.releases, 0);
});

test("an orphaned RUNNING row from a dead process is reclaimed as interrupted before the next attempt starts", async () => {
  const harness = createHarness();
  const orphan = await harness.store.create({
    id: "orphan-run",
    triggeredBy: "cron",
    attempt: 1,
    startedAt: STARTED_AT,
  });

  const result = await runScheduledRefresh(harness.deps);

  assert.equal(result.state, "succeeded");
  const reclaimed = await harness.store.get(orphan.id);
  assert.equal(reclaimed?.state, "FAILED");
  assert.deepEqual(reclaimed?.failures, [{ phase: "ORCHESTRATION", code: "INTERRUPTED_ORPHANED_RUN" }]);
});

test("resuming a partially failed run carries persisted successes without re-executing them", async () => {
  const harness = createHarness();
  const prior = await seedPartiallyFailedRun(harness.store);
  let rateWork = 0;

  const result = await runScheduledRefresh({
    ...harness.deps,
    snapshotRates: async () => { rateWork += 1; return rateSummary(); },
    evaluateReputation: async () => reputationSummary(),
  }, { resumeRunId: prior.id });

  assert.equal(rateWork, 0);
  assert.equal(result.state, "succeeded");
  assert.equal(result.resumedFromId, prior.id);
  assert.deepEqual(result.rates, {
    attempted: 1,
    succeeded: 1,
    failed: 0,
    skipped: 0,
    failures: [],
  });
  const resumed = await harness.store.get(result.runId);
  assert.equal(resumed?.attempt, 2);
  assert.equal(resumed?.resumedFromId, prior.id);
  assert.equal(resumed?.phases.rates.state, "SUCCEEDED");
  assert.equal(resumed?.phases.reputation.state, "SUCCEEDED");
});

test("resume refuses a successful or unknown run", async () => {
  const harness = createHarness();
  const succeeded = await harness.store.create({
    id: "succeeded-run",
    triggeredBy: "cron",
    attempt: 1,
    startedAt: STARTED_AT,
  });
  await harness.store.setPhase(succeeded.id, "rates", { state: "RUNNING", startedAt: STARTED_AT });
  await harness.store.setPhase(succeeded.id, "rates", { state: "SUCCEEDED", completedAt: STARTED_AT, summary: rateSummary() });
  await harness.store.setPhase(succeeded.id, "reputation", { state: "RUNNING", startedAt: STARTED_AT });
  await harness.store.setPhase(succeeded.id, "reputation", { state: "SUCCEEDED", completedAt: STARTED_AT, summary: reputationSummary() });
  await harness.store.complete(succeeded.id, {
    state: "SUCCEEDED",
    completedAt: STARTED_AT,
    failures: [],
    result: buildResult(succeeded.id, "succeeded", STARTED_AT),
  });

  await assert.rejects(
    runScheduledRefresh(harness.deps, { resumeRunId: succeeded.id }),
    RefreshRunNotResumableError,
  );
  await assert.rejects(runScheduledRefresh(harness.deps, { resumeRunId: "missing-run" }));
  assert.equal(harness.lock.state.releases, 2);
});

test("an orchestration exception before the run row exists still releases the lock", async () => {
  const harness = createHarness();
  const brokenStore: RefreshRunStore = Object.freeze({
    ...harness.store,
    findActive: async () => {
      throw new Error("ledger read failed");
    },
  });

  await assert.rejects(runScheduledRefresh({ ...harness.deps, runs: brokenStore }));

  assert.equal(harness.lock.state.releases, 1);
  assert.equal(harness.rows().length, 0);
});

test("sequential duplicate invocations each acquire the lock and stay independent", async () => {
  let rateRuns = 0;
  let reputationRuns = 0;
  const harness = createHarness({
    snapshotRates: async () => { rateRuns += 1; return rateSummary(); },
    evaluateReputation: async () => { reputationRuns += 1; return reputationSummary(); },
  });

  await runScheduledRefresh(harness.deps);
  await runScheduledRefresh(harness.deps);

  assert.equal(rateRuns, 2);
  assert.equal(reputationRuns, 2);
  assert.equal(harness.lock.state.acquires, 2);
  assert.equal(harness.lock.state.releases, 2);
  assert.equal(harness.rows().length, 2);
});

type Harness = {
  deps: ScheduledRefreshDependencies;
  store: RefreshRunStore;
  rows: () => readonly RefreshRunRecord[];
  lock: { state: { acquires: number; releases: number } };
  events: RefreshRunLogEvent[];
  order: string[];
};

function createHarness(
  overrides: Partial<ScheduledRefreshDependencies> = {},
  options: Readonly<{ lock?: "acquired" | "unavailable" }> = {},
): Harness {
  const { store, rows } = createInMemoryRefreshRunStore();
  const { provider, state: lockState } = createFakeLockProvider(options.lock);
  const events: RefreshRunLogEvent[] = [];
  const order: string[] = [];
  const clock = steppingClock();
  let id = 0;

  const deps: ScheduledRefreshDependencies = Object.freeze({
    snapshotRates: async () => rateSummary(),
    evaluateReputation: async () => reputationSummary(),
    now: clock,
    newRunId: () => `run-${++id}`,
    lock: provider,
    runs: store,
    log: (event) => { events.push(event); },
    ...overrides,
  }) as ScheduledRefreshDependencies;

  return {
    deps,
    store,
    rows,
    lock: { state: lockState },
    events,
    order,
  };
}

async function seedPartiallyFailedRun(store: RefreshRunStore): Promise<RefreshRunRecord> {
  const prior = await store.create({
    id: "prior-run",
    triggeredBy: "cron",
    attempt: 1,
    startedAt: STARTED_AT,
  });
  await store.setPhase(prior.id, "rates", { state: "RUNNING", startedAt: STARTED_AT });
  await store.setPhase(prior.id, "rates", {
    state: "SUCCEEDED",
    completedAt: STARTED_AT,
    summary: { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] },
  });
  await store.setPhase(prior.id, "reputation", { state: "RUNNING", startedAt: STARTED_AT });
  await store.setPhase(prior.id, "reputation", {
    state: "FAILED",
    completedAt: STARTED_AT,
    summary: {
      attempted: 3,
      succeeded: 2,
      failed: 1,
      failures: [{ anchorSlug: "moneygram", code: "EVIDENCE_READ_FAILURE" }],
    },
  });
  return store.complete(prior.id, {
    state: "PARTIALLY_SUCCEEDED",
    completedAt: STARTED_AT,
    failures: [{ phase: "reputation", code: "EVIDENCE_READ_FAILURE", anchorSlug: "moneygram" }],
    result: buildResult(prior.id, "partially_succeeded", STARTED_AT),
  });
}

function steppingClock(start = STARTED_AT): () => Date {
  let tick = 0;
  return () => new Date(start.getTime() + tick++ * 1_000);
}

function buildResult(runId: string, state: ScheduledRefreshResult["state"], at: Date): ScheduledRefreshResult {
  return Object.freeze({
    ok: state === "succeeded",
    runId,
    state,
    activeRunId: null,
    resumedFromId: null,
    startedAt: at.toISOString(),
    completedAt: at.toISOString(),
    rates: Object.freeze({ attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] }),
    reputation: Object.freeze({ attempted: 3, succeeded: 3, failed: 0, failures: [] }),
  });
}

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


test("deterministic normalization failures are recorded but transient failures are not", async () => {
  const recorded: unknown[] = [];
  const suppressions = {
    listSuppressed: async () => [],
    recordDeterministicFailure: async (input: unknown) => {
      recorded.push(input);
      return {} as never;
    },
    reactivate: async () => null,
  };

  await runScheduledRefresh(dependencies({
    suppressions,
    snapshotRates: async () => rateSummary({
      succeeded: 0,
      failed: 2,
      snapshotsPersisted: 0,
      failures: [
        {
          anchorSlug: "anchor-a",
          corridorSlug: "usdc-us-brl-br",
          phase: "NORMALIZATION",
          code: "ASSET_MISMATCH",
        },
        {
          anchorSlug: "anchor-b",
          corridorSlug: "usdc-us-brl-br",
          phase: "QUOTE",
          code: "QUOTE_FAILURE",
        },
      ],
    }),
  }));

  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0], {
    anchorSlug: "anchor-a",
    corridorSlug: "usdc-us-brl-br",
    reason: "PERMANENT_PROTOCOL",
    failureCode: "ASSET_MISMATCH",
    failurePhase: "NORMALIZATION",
    observedAt: STARTED_AT,
  });
});
