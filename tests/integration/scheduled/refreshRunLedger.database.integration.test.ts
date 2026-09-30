import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPostgresRefreshLockProvider } from "@/lib/scheduled/refreshLock";
import { createPrismaRefreshRunStore } from "@/lib/scheduled/refreshRunRepository";
import { runScheduledRefresh } from "@/lib/scheduled/refresh";
import type { SafeLiveRateRunSummary } from "@/types/liveRateSource";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_REFRESH_DATABASE_INTEGRATION === "1";

test("two advisory-lock sessions contend and exactly one acquires; release frees the lock", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const first = createPostgresRefreshLockProvider();
  const second = createPostgresRefreshLockProvider();

  const firstLease = await first.acquire();
  assert.equal(firstLease.acquired, true);
  try {
    const blocked = await second.acquire();
    assert.equal(blocked.acquired, false);
  } finally {
    if (firstLease.acquired) await firstLease.lease.release();
  }

  const reacquired = await second.acquire();
  assert.equal(reacquired.acquired, true);
  if (reacquired.acquired) await reacquired.lease.release();
});

test("the orchestrator persists a durable run, releases the lock on failure, and allows the next run", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const runIds: string[] = [];

  try {
    const failed = await runScheduledRefresh({
      snapshotRates: async () => { throw new Error("rate source unavailable"); },
      evaluateReputation: async () => ({ attempted: 1, succeeded: 1, failed: 0, failures: [] }),
      now: () => new Date(),
      newRunId: () => {
        const id = randomUUID();
        runIds.push(id);
        return id;
      },
      lock: createPostgresRefreshLockProvider(),
      runs: createPrismaRefreshRunStore(),
      log: () => {},
    });

    assert.equal(failed.state, "partially_succeeded");
    const persistedFailure = await db.refreshRun.findUnique({ where: { id: failed.runId } });
    assert.equal(persistedFailure?.state, "PARTIALLY_SUCCEEDED");
    assert.deepEqual(persistedFailure?.failures, [{ phase: "rates", code: "LIVE_RATE_PREPARATION_FAILURE" }]);

    const reacquired = await createPostgresRefreshLockProvider().acquire();
    assert.equal(reacquired.acquired, true);
    if (reacquired.acquired) await reacquired.lease.release();

    const succeeded = await runScheduledRefresh({
      snapshotRates: async () => rateSummary(),
      evaluateReputation: async () => ({ attempted: 1, succeeded: 1, failed: 0, failures: [] }),
      now: () => new Date(),
      newRunId: () => {
        const id = randomUUID();
        runIds.push(id);
        return id;
      },
      lock: createPostgresRefreshLockProvider(),
      runs: createPrismaRefreshRunStore(),
      log: () => {},
    });
    assert.equal(succeeded.state, "succeeded");
    const persistedSuccess = await db.refreshRun.findUnique({ where: { id: succeeded.runId } });
    assert.equal(persistedSuccess?.state, "SUCCEEDED");
    assert.equal((persistedSuccess?.result as { runId?: string } | null)?.runId, succeeded.runId);
  } finally {
    await db.refreshRun.deleteMany({ where: { id: { in: runIds } } });
    await db.$disconnect();
  }
});

test("two concurrent refresh attempts to PostgreSQL produce exactly one active run", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");

  let releaseRates = () => {};
  const ratesGate = new Promise<void>((resolve) => { releaseRates = resolve; });
  let notifyStarted = () => {};
  const startSignal = new Promise<void>((resolve) => { notifyStarted = resolve; });

  const dependencies = {
    snapshotRates: async (): Promise<SafeLiveRateRunSummary> => {
      notifyStarted();
      await ratesGate;
      return rateSummary();
    },
    evaluateReputation: async () => ({ attempted: 1, succeeded: 1, failed: 0, failures: [] }),
    now: () => new Date(),
    newRunId: () => randomUUID(),
    lock: createPostgresRefreshLockProvider(),
    runs: createPrismaRefreshRunStore(),
    log: () => {},
  };
  let activeRunId: string | null = null;

  try {
    const first = runScheduledRefresh(dependencies);
    await startSignal;

    const activeRow = await db.refreshRun.findFirst({
      where: { state: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    assert.notEqual(activeRow, null);
    activeRunId = activeRow?.id ?? null;

    const second = await runScheduledRefresh(dependencies);
    assert.equal(second.state, "already_running");
    assert.equal(second.ok, true);
    assert.equal(second.activeRunId, activeRunId);

    releaseRates();
    const firstResult = await first;
    assert.equal(firstResult.state, "succeeded");
    assert.equal(firstResult.runId, activeRunId);

    const stillRunning = await db.refreshRun.count({ where: { state: "RUNNING", id: activeRunId ?? undefined } });
    assert.equal(stillRunning, 0);
  } finally {
    releaseRates();
    if (activeRunId !== null) await db.refreshRun.deleteMany({ where: { id: activeRunId } });
    await db.$disconnect();
  }
});

test("resume carries only persisted successes from a prior database run", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const runIds: string[] = [];

  try {
    const store = createPrismaRefreshRunStore();
    const priorId = randomUUID();
    runIds.push(priorId);
    const startedAt = new Date();
    await store.create({ id: priorId, triggeredBy: "cron", attempt: 1, startedAt });
    await store.setPhase(priorId, "rates", { state: "RUNNING", startedAt });
    await store.setPhase(priorId, "rates", {
      state: "SUCCEEDED",
      completedAt: new Date(),
      summary: { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] },
    });
    await store.setPhase(priorId, "reputation", { state: "RUNNING", startedAt });
    await store.setPhase(priorId, "reputation", {
      state: "FAILED",
      completedAt: new Date(),
      summary: { attempted: 1, succeeded: 0, failed: 1, failures: [{ anchorSlug: "zeam", code: "EVIDENCE_READ_FAILURE" }] },
    });
    await store.complete(priorId, {
      state: "PARTIALLY_SUCCEEDED",
      completedAt: new Date(),
      failures: [{ phase: "reputation", code: "EVIDENCE_READ_FAILURE", anchorSlug: "zeam" }],
      result: {
        ok: false,
        runId: priorId,
        state: "partially_succeeded",
        activeRunId: null,
        resumedFromId: null,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        rates: { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] },
        reputation: { attempted: 1, succeeded: 0, failed: 1, failures: [{ anchorSlug: "zeam", code: "EVIDENCE_READ_FAILURE" }] },
      },
    });

    let rateWork = 0;
    const resumed = await runScheduledRefresh({
      snapshotRates: async () => { rateWork += 1; return rateSummary(); },
      evaluateReputation: async () => ({ attempted: 1, succeeded: 1, failed: 0, failures: [] }),
      now: () => new Date(),
      newRunId: () => {
        const id = randomUUID();
        runIds.push(id);
        return id;
      },
      lock: createPostgresRefreshLockProvider(),
      runs: createPrismaRefreshRunStore(),
      log: () => {},
    }, { resumeRunId: priorId });

    assert.equal(rateWork, 0);
    assert.equal(resumed.state, "succeeded");
    assert.equal(resumed.resumedFromId, priorId);
    assert.equal(resumed.rates.succeeded, 1);

    const resumedRow = await db.refreshRun.findUnique({ where: { id: resumed.runId } });
    assert.equal(resumedRow?.attempt, 2);
    assert.equal(resumedRow?.resumedFromId, priorId);
    const phases = resumedRow?.phaseStates as { rates?: { state?: string } } | null;
    assert.equal(phases?.rates?.state, "SUCCEEDED");
  } finally {
    await db.refreshRun.deleteMany({ where: { id: { in: runIds } } });
    await db.$disconnect();
  }
});

test("database guards reject malformed attempts and inconsistent completion state", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const runIds: string[] = [];

  try {
    const invalidAttemptId = randomUUID();
    runIds.push(invalidAttemptId);
    await assert.rejects(db.refreshRun.create({
      data: { id: invalidAttemptId, triggeredBy: "cron", attempt: 0 },
    }));

    const inconsistentId = randomUUID();
    runIds.push(inconsistentId);
    await assert.rejects(db.refreshRun.create({
      data: { id: inconsistentId, triggeredBy: "cron", state: "SUCCEEDED", completedAt: null },
    }));

    const invalidTriggerId = randomUUID();
    runIds.push(invalidTriggerId);
    await assert.rejects(db.refreshRun.create({
      data: { id: invalidTriggerId, triggeredBy: "", attempt: 1 },
    }));
  } finally {
    await db.refreshRun.deleteMany({ where: { id: { in: runIds } } });
    await db.$disconnect();
  }
});

function rateSummary(): SafeLiveRateRunSummary {
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
  });
}
