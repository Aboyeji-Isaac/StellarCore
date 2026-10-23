/**
 * Concurrency-control tests for representative scheduled evidence workflows.
 *
 * The scheduled refresh owns one non-blocking PostgreSQL advisory lock
 * (`refresh:scheduled-refresh:v1:global`) and runs on a bounded pool. These
 * tests drive controlled concurrent invocations through the real lock boundary
 * (`withAdvisoryLock`) and the real workflow orchestration
 * (`runScheduledRefresh`, `snapshotReviewedLiveRates`,
 * `evaluatePersistedAnchorReputations`), replacing only the database and
 * network boundaries with deterministic doubles.
 *
 * Covered contracts:
 * 1. Simultaneous work stays within the configured execution bound (one lock
 *    holder) and connection bound (pool maximum).
 * 2. Queued work waits for a freed connection and then runs; rejected work
 *    returns `already_held` without an error and without starting any
 *    evidence work.
 * 3. A failed execution releases both the lock and the connection, so the next
 *    cycle can acquire the slot.
 * 4. Nothing depends on wall-clock time, the production scheduler, a database,
 *    or the network.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { snapshotReviewedLiveRates } from "@/lib/rates/snapshotRun";
import {
  evaluatePersistedAnchorReputations,
  type ReputationEvaluationRunSummary,
} from "@/lib/reputation/run";
import { withAdvisoryLock } from "@/lib/scheduled/advisoryLockClient";
import { LOCK_REGISTRY } from "@/lib/scheduled/advisoryLockKey";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import {
  createFakeAdvisoryLockPool,
  type FakeAdvisoryLockPool,
} from "@/tests/support/fakeAdvisoryLockPool";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";
import type { ScheduledRefreshResult } from "@/types/scheduled";

const REFRESH_LOCK = LOCK_REGISTRY.find(
  (entry) => entry.logicalName === "refresh:scheduled-refresh:v1:global",
)!;
const EVALUATED_AT = new Date("2026-09-01T00:00:00.000Z");

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
  attempted: 3,
  succeeded: 3,
  failed: 0,
  failures: Object.freeze([]),
});

// ---------------------------------------------------------------------------
// Controlled-concurrency helpers
// ---------------------------------------------------------------------------

function createDeferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return Object.freeze({ promise, resolve });
}

function lockDependencies(pool: FakeAdvisoryLockPool) {
  return Object.freeze({
    checkoutClient: pool.checkoutClient,
    releaseClient: pool.releaseClient,
  });
}

/** Representative scheduled cycle with only the evidence boundaries doubled. */
function trackedRefresh(
  counters: { rate: number; reputation: number },
  options: Readonly<{ failReputation?: boolean }> = {},
): () => Promise<ScheduledRefreshResult> {
  return () => runScheduledRefresh({
    snapshotRates: async () => {
      counters.rate += 1;
      return RATE_SUMMARY;
    },
    evaluateReputation: async () => {
      counters.reputation += 1;
      if (options.failReputation) throw new Error("reputation evidence store unavailable");
      return REPUTATION_SUMMARY;
    },
    now: () => EVALUATED_AT,
  });
}

function completedRefresh(outcome: { lock: { acquired: boolean } }): ScheduledRefreshResult {
  assert.ok("result" in outcome, "the acquiring invocation must return the cycle result");
  return (outcome as { result: ScheduledRefreshResult }).result;
}

// ---------------------------------------------------------------------------
// 1. Simultaneous work stays within configured bounds
// ---------------------------------------------------------------------------

test("simultaneous scheduled refreshes stay within the configured execution and connection bounds", async () => {
  const pool = createFakeAdvisoryLockPool({ maxConnections: 2 });
  const gate = createDeferred();
  const counters = { rate: 0, reputation: 0 };
  const refresh = trackedRefresh(counters);
  let inFlight = 0;
  let peakInFlight = 0;

  const invoke = () => withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        await gate.promise;
        return await refresh();
      } finally {
        inFlight -= 1;
      }
    },
    lockDependencies(pool),
  );

  const invocations = [invoke(), invoke(), invoke(), invoke()];
  await pool.waitForAcquireAttempts(4);

  assert.equal(pool.stats().acquired, 1, "exactly one invocation may own the refresh lock");
  assert.equal(pool.stats().rejected, 3);
  assert.equal(peakInFlight, 1, "only one scheduled cycle may execute at a time");
  assert.equal(
    pool.stats().peakActiveCheckouts,
    2,
    "simultaneous checkouts must stay within the configured pool maximum",
  );
  assert.equal(counters.rate, 0, "rejected invocations must not start the rate workflow");
  assert.equal(
    counters.reputation,
    0,
    "rejected invocations must not start the reputation workflow",
  );

  gate.resolve();
  const outcomes = await Promise.all(invocations);
  const completed = outcomes.filter((outcome) => outcome.lock.acquired);
  const rejected = outcomes.filter((outcome) => !outcome.lock.acquired);

  assert.equal(completed.length, 1);
  assert.equal(rejected.length, 3);
  const cycle = completedRefresh(completed[0]!);
  assert.equal(cycle.ok, true);
  assert.equal(cycle.rates.attempted, 1);

  for (const outcome of rejected) {
    assert.equal("result" in outcome, false);
    assert.deepEqual(outcome.lock, {
      acquired: false,
      key: REFRESH_LOCK.derivedKey,
      reason: "already_held",
    });
  }

  assert.equal(counters.rate, 1, "the rate workflow runs exactly once per refresh cycle");
  assert.equal(counters.reputation, 1);
  assert.equal(inFlight, 0);
  assert.deepEqual(pool.heldKeys(), [], "the refresh lock must not remain held");
  assert.equal(pool.stats().activeCheckouts, 0, "every checked-out connection must be returned");
  assert.equal(pool.stats().checkouts, pool.stats().releases);
});

// ---------------------------------------------------------------------------
// 2. Queued and rejected work follow the existing scheduler contract
// ---------------------------------------------------------------------------

test("queued work waits for a bounded connection and then runs its evidence cycle", async () => {
  const pool = createFakeAdvisoryLockPool({ maxConnections: 1 });
  const gate = createDeferred();
  const events: string[] = [];
  const counters = { rate: 0, reputation: 0 };

  const first = withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    async () => {
      events.push("first:start");
      await gate.promise;
      const result = await trackedRefresh(counters)();
      events.push("first:end");
      return result;
    },
    lockDependencies(pool),
  );

  await pool.waitForAcquireAttempts(1);
  assert.equal(pool.stats().acquired, 1);
  assert.equal(pool.stats().activeCheckouts, 1);

  const second = withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    async () => {
      events.push("second:start");
      return trackedRefresh(counters)();
    },
    lockDependencies(pool),
  );

  // The checkouts are requested synchronously, so the queue is observable here
  // without waiting on a timer or a production scheduler.
  assert.equal(pool.stats().queuedCheckouts, 1, "the second cycle must queue for the only connection");
  assert.equal(
    pool.stats().acquireAttempts,
    1,
    "queued work must not attempt the lock before a connection is available",
  );
  assert.equal(pool.stats().activeCheckouts, 1);
  assert.equal(
    pool.stats().peakActiveCheckouts,
    1,
    "a one-connection bound must never be exceeded by queued work",
  );

  gate.resolve();
  const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
  assert.ok(firstOutcome);
  assert.ok(secondOutcome);

  assert.equal(firstOutcome.lock.acquired, true);
  assert.equal(secondOutcome.lock.acquired, true, "the queued cycle runs once the slot is free");
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  assert.equal(counters.rate, 2);
  assert.equal(counters.reputation, 2);
  assert.equal(pool.stats().rejected, 0, "queued work must not be reported as already_held");
  assert.equal(pool.stats().peakActiveCheckouts, 1);
  assert.equal(pool.stats().activeCheckouts, 0);
  assert.deepEqual(pool.heldKeys(), []);
});

// ---------------------------------------------------------------------------
// 3. A failed execution does not permanently consume the slot
// ---------------------------------------------------------------------------

test("a failed scheduled execution releases its lock and connection for the next cycle", async () => {
  const pool = createFakeAdvisoryLockPool({ maxConnections: 2 });
  const counters = { rate: 0, reputation: 0 };

  const failing = withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    () => trackedRefresh(counters, { failReputation: true })(),
    lockDependencies(pool),
  );

  await assert.rejects(failing, /reputation evidence store unavailable/);

  assert.equal(counters.rate, 1, "the failure happens after rate ingestion");
  assert.equal(pool.stats().unlockAttempts, 1, "the failure path must unlock the advisory lock");
  assert.equal(pool.holdsKey(REFRESH_LOCK.derivedKey), false);
  assert.deepEqual(pool.heldKeys(), []);
  assert.equal(pool.stats().activeCheckouts, 0, "the connection must be returned to the pool");
  assert.equal(pool.stats().checkouts, pool.stats().releases);

  const recovered = await withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    () => trackedRefresh(counters)(),
    lockDependencies(pool),
  );

  assert.equal(recovered.lock.acquired, true, "the failed run must not consume the slot");
  assert.equal(completedRefresh(recovered).ok, true);
  assert.equal(pool.stats().acquired, 2);
  assert.equal(pool.stats().rejected, 0);
  assert.deepEqual(pool.heldKeys(), []);
});

// ---------------------------------------------------------------------------
// 4. Representative evidence workflows share one exclusion identity
// ---------------------------------------------------------------------------

test("concurrent rate-snapshot and reputation-evaluation workflows honour one exclusion identity", async () => {
  const pool = createFakeAdvisoryLockPool({ maxConnections: 4 });
  const gate = createDeferred();
  let rateWorkflowRuns = 0;
  let reputationWorkflowRuns = 0;

  const rateWorkflow = withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    async () => {
      rateWorkflowRuns += 1;
      await gate.promise;
      return snapshotReviewedLiveRates({
        assertConfiguration: () => undefined,
        buildCandidates: async () => Object.freeze([]),
        executeCandidates: async (candidates) => Object.freeze({
          ...RATE_SUMMARY,
          totalCandidates: candidates.length,
          totalAttempted: candidates.length,
          succeeded: candidates.length,
          snapshotsPersisted: candidates.length,
        }),
        listSuppressed: async () => Object.freeze([]),
      });
    },
    lockDependencies(pool),
  );

  await pool.waitForAcquireAttempts(1);

  const reputationWorkflow = await withAdvisoryLock(
    REFRESH_LOCK.derivedKey,
    async () => {
      reputationWorkflowRuns += 1;
      return evaluatePersistedAnchorReputations({
        anchorSlugs: ["zeam"],
        evaluatedAt: EVALUATED_AT,
        dependencies: {
          listAnchorSlugs: async () => Object.freeze([]),
          evaluate: async (anchorSlug) => Object.freeze({
            ok: false as const,
            anchorSlug,
            code: "ANCHOR_NOT_FOUND" as const,
          }),
        },
      });
    },
    lockDependencies(pool),
  );

  assert.equal(rateWorkflowRuns, 1);
  assert.equal(
    reputationWorkflowRuns,
    0,
    "rejected work must not start the reputation evidence workflow",
  );
  assert.equal(reputationWorkflow.lock.acquired, false);
  assert.equal("result" in reputationWorkflow, false);
  assert.equal(pool.stats().rejected, 1);

  gate.resolve();
  const rateOutcome = await rateWorkflow;
  assert.equal(rateOutcome.lock.acquired, true);
  assert.ok("result" in rateOutcome);
  const summary = (rateOutcome as { result: SafeLiveRateRunSummary }).result;
  assert.equal(summary.totalAttempted, 0);
  assert.equal(summary.suppressed, 0);
  assert.deepEqual(pool.heldKeys(), []);
  assert.equal(pool.stats().activeCheckouts, 0);
});
