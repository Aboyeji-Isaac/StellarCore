import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as statusRoute from "@/app/api/internal/refresh/status/route";
import {
  REFRESH_CADENCE_MS,
  REFRESH_CRON_SCHEDULE,
  REFRESH_GRACE_MS,
  REFRESH_PIPELINE,
} from "@/constants/refresh";
import {
  applyRunCompleted,
  applyRunStarted,
  classifyRefreshRun,
  evaluateRefreshWatchdog,
  nextScheduledSlotAfter,
} from "@/lib/scheduled/watchdog";
import { getRefreshWatchdogResponse } from "@/lib/scheduled/watchdogHttp";
import { readRefreshWatchdogStatus, runWatchedScheduledRefresh } from "@/lib/scheduled/watchdogRun";
import type { RefreshWatchdogRepository, RefreshWatchdogState } from "@/types/refreshWatchdog";
import type { ScheduledRefreshResult } from "@/types/scheduled";

const DEPLOYED_AT = at("2026-09-29T10:00:00.000Z");
const FIRST_SLOT = at("2026-09-30T00:00:00.000Z");
const MS = 1;

test("cadence constants match the production cron schedule", () => {
  const vercel = JSON.parse(readFileSync("vercel.json", "utf8")) as {
    crons: { path: string; schedule: string }[];
  };
  const refresh = vercel.crons.find(({ path }) => path === "/api/internal/cron/refresh");
  assert.equal(refresh?.schedule, REFRESH_CRON_SCHEDULE);
  assert.equal(REFRESH_CRON_SCHEDULE, "0 0 * * *");
  assert.equal(REFRESH_CADENCE_MS, 24 * 60 * 60 * 1_000);
  assert.equal(REFRESH_GRACE_MS, 2 * 60 * 60 * 1_000);
});

test("the next expected slot is strictly after the reference instant", () => {
  assert.equal(iso(nextScheduledSlotAfter(DEPLOYED_AT)), iso(FIRST_SLOT));
  assert.equal(iso(nextScheduledSlotAfter(FIRST_SLOT)), "2026-10-01T00:00:00.000Z");
  assert.equal(iso(nextScheduledSlotAfter(shift(FIRST_SLOT, -MS))), iso(FIRST_SLOT));
});

test("1. no refresh ever: awaiting until the first slot plus grace, then stale", async () => {
  const store = memoryStore(seeded());
  const staleAt = shift(FIRST_SLOT, REFRESH_GRACE_MS);

  const before = await status(store, shift(FIRST_SLOT, 1_000));
  assert.equal(before.state, "awaiting_first_refresh");
  assert.equal(before.latestRun.state, "none");
  assert.equal(before.staleAt, iso(staleAt));

  const after = await status(store, shift(staleAt, REFRESH_CADENCE_MS));
  assert.equal(after.state, "stale");
  assert.equal(after.staleReason, "no_successful_refresh");
  assert.equal(after.lastSuccessfulRefreshAt, null);
});

test("missing watchdog state is reported stale rather than healthy", () => {
  const result = evaluateRefreshWatchdog(null, FIRST_SLOT, REFRESH_PIPELINE);
  assert.equal(result.state, "stale");
  assert.equal(result.staleReason, "no_watchdog_state");
});

test("2. a successful refresh is fresh before the stale boundary", async () => {
  const store = memoryStore(seeded());
  const completedAt = shift(FIRST_SLOT, 10_000);
  await watched(store, successfulRun(), [FIRST_SLOT, completedAt]);

  const result = await status(store, shift(completedAt, 60 * 60 * 1_000));
  assert.equal(result.state, "fresh");
  assert.equal(result.lastSuccessfulRefreshAt, iso(completedAt));
  assert.equal(result.expectedRefreshAt, "2026-10-01T00:00:00.000Z");
  assert.equal(result.staleAt, "2026-10-01T02:00:00.000Z");
});

test("3. the exact expected cadence instant is still fresh (inside grace)", () => {
  const state = successState(shift(FIRST_SLOT, 10_000));
  const expected = at("2026-10-01T00:00:00.000Z");
  assert.equal(evaluateRefreshWatchdog(state, shift(expected, -MS), REFRESH_PIPELINE).state, "fresh");
  assert.equal(evaluateRefreshWatchdog(state, expected, REFRESH_PIPELINE).state, "fresh");
  assert.equal(evaluateRefreshWatchdog(state, shift(expected, MS), REFRESH_PIPELINE).state, "fresh");
});

test("4. grace boundary: fresh just before and exactly at staleAt, stale 1 ms after", () => {
  const state = successState(shift(FIRST_SLOT, 10_000));
  const staleAt = at("2026-10-01T02:00:00.000Z");
  assert.equal(evaluateRefreshWatchdog(state, shift(staleAt, -MS), REFRESH_PIPELINE).state, "fresh");
  assert.equal(evaluateRefreshWatchdog(state, staleAt, REFRESH_PIPELINE).state, "fresh");
  const after = evaluateRefreshWatchdog(state, shift(staleAt, MS), REFRESH_PIPELINE);
  assert.equal(after.state, "stale");
  assert.equal(after.staleReason, "missed_expected_refresh");

  const neverRan = seeded();
  const firstStaleAt = shift(FIRST_SLOT, REFRESH_GRACE_MS);
  assert.equal(evaluateRefreshWatchdog(neverRan, firstStaleAt, REFRESH_PIPELINE).state, "awaiting_first_refresh");
  assert.equal(evaluateRefreshWatchdog(neverRan, shift(firstStaleAt, MS), REFRESH_PIPELINE).state, "stale");
});

test("5. a failed refresh keeps the previous heartbeat and eventually goes stale", async () => {
  const store = memoryStore(seeded());
  const firstSuccess = shift(FIRST_SLOT, 10_000);
  await watched(store, successfulRun(), [FIRST_SLOT, firstSuccess]);

  const nextSlot = at("2026-10-01T00:00:00.000Z");
  await assert.rejects(watched(store, async () => {
    throw new Error("fatal reputation failure");
  }, [nextSlot, shift(nextSlot, 5_000)]), /fatal reputation failure/);

  const degraded = await status(store, shift(nextSlot, 60_000));
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.latestRun.state, "failed");
  assert.equal(degraded.latestRun.failureCode, "REFRESH_FATAL");
  assert.equal(degraded.lastSuccessfulRefreshAt, iso(firstSuccess));
  assert.equal(degraded.consecutiveUnsuccessfulRuns, 1);

  const stale = await status(store, shift(nextSlot, REFRESH_GRACE_MS + MS));
  assert.equal(stale.state, "stale");
  assert.equal(stale.lastSuccessfulRefreshAt, iso(firstSuccess));
});

test("a completed run that produced no evidence is failed and does not advance the heartbeat", async () => {
  const store = memoryStore(seeded());
  const result = await watched(store, async () => refreshResult({
    rates: { attempted: 1, succeeded: 0, failed: 1, skipped: 0, failures: [] },
    reputation: { attempted: 3, succeeded: 0, failed: 3, failures: [] },
  }), [FIRST_SLOT, shift(FIRST_SLOT, 1_000)]);
  assert.deepEqual(result.watchdog, { outcome: "failed", recorded: true });
  assert.equal(store.state()?.lastSuccessfulRefreshAt, null);
  assert.equal(store.state()?.lastRunFailureCode, "NO_EVIDENCE_PRODUCED");
});

test("6. a partial refresh is distinguishable and never claims fresh evidence", async () => {
  const store = memoryStore(seeded());
  const partial = await watched(store, async () => refreshResult({
    ok: false,
    rates: { attempted: 2, succeeded: 1, failed: 1, skipped: 0, failures: [] },
  }), [FIRST_SLOT, shift(FIRST_SLOT, 1_000)]);
  assert.deepEqual(partial.watchdog, { outcome: "partial", recorded: true });

  const result = await status(store, shift(FIRST_SLOT, 60_000));
  assert.equal(result.latestRun.state, "partial");
  assert.equal(result.latestRun.failureCode, "RATE_SOURCE_FAILURES");
  assert.equal(result.lastSuccessfulRefreshAt, null);
  assert.notEqual(result.state, "fresh");
  assert.equal(result.state, "awaiting_first_refresh");

  const afterGrace = await status(store, shift(FIRST_SLOT, REFRESH_GRACE_MS + MS));
  assert.equal(afterGrace.state, "stale");
});

test("7. a successful refresh advances the heartbeat only on completion", async () => {
  const store = memoryStore(seeded());
  const completedAt = shift(FIRST_SLOT, 10_000);
  let heartbeatDuringRun: Date | null | undefined;
  let latestDuringRun: string | undefined;
  const result = await watched(store, async () => {
    heartbeatDuringRun = store.state()?.lastSuccessfulRefreshAt;
    latestDuringRun = evaluateRefreshWatchdog(store.state(), FIRST_SLOT, REFRESH_PIPELINE).latestRun.state;
    return refreshResult();
  }, [FIRST_SLOT, completedAt]);

  assert.equal(heartbeatDuringRun, null);
  assert.equal(latestDuringRun, "in_progress");
  assert.deepEqual(result.watchdog, { outcome: "successful", recorded: true });
  const after = await status(store, completedAt);
  assert.equal(after.state, "fresh");
  assert.equal(after.latestRun.state, "successful");
  assert.equal(after.lastSuccessfulRefreshAt, iso(completedAt));
  assert.equal(after.consecutiveUnsuccessfulRuns, 0);
});

test("8. recovery: a stale watchdog becomes fresh after a successful run", async () => {
  const store = memoryStore(seeded());
  const lateSlot = at("2026-10-03T00:00:00.000Z");
  assert.equal((await status(store, lateSlot)).state, "stale");

  await watched(store, async () => refreshResult({
    ok: false,
    reputation: { attempted: 3, succeeded: 2, failed: 1, failures: [] },
  }), [lateSlot, shift(lateSlot, 1_000)]);
  assert.equal((await status(store, shift(lateSlot, 2_000))).state, "stale");

  const recoveredAt = shift(lateSlot, 5_000);
  await watched(store, successfulRun(), [shift(lateSlot, 3_000), recoveredAt]);
  const recovered = await status(store, shift(recoveredAt, 1_000));
  assert.equal(recovered.state, "fresh");
  assert.equal(recovered.staleReason, null);
  assert.equal(recovered.consecutiveUnsuccessfulRuns, 0);
});

test("9. state survives a process restart through durable storage only", async () => {
  const durable = { serialized: serialize(seeded()) };
  const firstProcess = memoryStore(null, durable);
  const completedAt = shift(FIRST_SLOT, 10_000);
  await watched(firstProcess, successfulRun(), [FIRST_SLOT, completedAt]);
  const beforeRestart = await status(firstProcess, shift(completedAt, 1_000));

  const restarted = memoryStore(null, durable);
  const afterRestart = await status(restarted, shift(completedAt, 1_000));
  assert.deepEqual(afterRestart, beforeRestart);
  assert.equal(afterRestart.state, "fresh");
  assert.equal(
    (await status(restarted, at("2026-10-01T02:00:00.001Z"))).state,
    "stale",
  );
});

test("an interrupted run leaves an in-progress record and the heartbeat untouched", async () => {
  const durable = { serialized: serialize(successState(shift(FIRST_SLOT, 10_000))) };
  const crashed = memoryStore(null, durable);
  const nextSlot = at("2026-10-01T00:00:00.000Z");
  await crashed.repository.transition(REFRESH_PIPELINE, (current) =>
    applyRunStarted(current, REFRESH_PIPELINE, "run-crashed", nextSlot));

  const restarted = memoryStore(null, durable);
  const during = await status(restarted, shift(nextSlot, 60_000));
  assert.equal(during.latestRun.state, "in_progress");
  assert.equal(during.lastSuccessfulRefreshAt, iso(shift(FIRST_SLOT, 10_000)));
  assert.equal((await status(restarted, shift(nextSlot, REFRESH_GRACE_MS + MS))).state, "stale");
});

test("10. reading status never runs a refresh or writes evidence or watchdog state", async () => {
  const store = memoryStore(seeded());
  const before = serialize(store.state());
  const result = await readRefreshWatchdogStatus({ repository: store.repository, now: () => FIRST_SLOT });
  assert.equal(store.transitions(), 0);
  assert.equal(serialize(store.state()), before);
  const body = JSON.stringify(result);
  for (const key of ["median", "rate\"", "score", "snapshot"]) {
    assert.equal(body.includes(key), false, key);
  }
});

test("an older overlapping run cannot overwrite a newer run, and the heartbeat never moves backwards", () => {
  const newerSuccess = shift(FIRST_SLOT, 20_000);
  let state = applyRunStarted(seeded(), REFRESH_PIPELINE, "old", FIRST_SLOT);
  state = applyRunStarted(state, REFRESH_PIPELINE, "new", shift(FIRST_SLOT, 1_000));
  state = applyRunCompleted(state, REFRESH_PIPELINE, {
    runId: "new", startedAt: shift(FIRST_SLOT, 1_000), completedAt: newerSuccess,
  }, { outcome: "successful", failureCode: null });
  state = applyRunCompleted(state, REFRESH_PIPELINE, {
    runId: "old", startedAt: FIRST_SLOT, completedAt: shift(FIRST_SLOT, 30_000),
  }, { outcome: "failed", failureCode: "REFRESH_FATAL" });
  assert.equal(state.lastRunId, "new");
  assert.equal(state.lastRunOutcome, "successful");
  assert.equal(state.consecutiveUnsuccessfulRuns, 0);

  const earlier = applyRunCompleted(state, REFRESH_PIPELINE, {
    runId: "late-report", startedAt: shift(FIRST_SLOT, -60_000), completedAt: shift(FIRST_SLOT, 5_000),
  }, { outcome: "successful", failureCode: null });
  assert.equal(iso(earlier.lastSuccessfulRefreshAt!), iso(newerSuccess));
});

test("a watchdog write failure does not fail the refresh and does not claim a heartbeat", async () => {
  const failing: RefreshWatchdogRepository = {
    read: async () => null,
    transition: async () => {
      throw new Error("DATABASE_URL=postgres://secret");
    },
  };
  const clock = [FIRST_SLOT, shift(FIRST_SLOT, 1_000)];
  const result = await runWatchedScheduledRefresh({
    run: async () => refreshResult(),
    repository: failing,
    now: () => clock.shift()!,
    runId: () => "run-1",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.watchdog, { outcome: "successful", recorded: false });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("classification is by produced evidence, not by the run starting", () => {
  assert.deepEqual(classifyRefreshRun(refreshResult()), { outcome: "successful", failureCode: null });
  assert.deepEqual(classifyRefreshRun(refreshResult({
    rates: { attempted: 0, succeeded: 0, failed: 0, skipped: 0, failures: [] },
  })), { outcome: "partial", failureCode: "NO_RATE_EVIDENCE" });
  assert.deepEqual(classifyRefreshRun(refreshResult({
    ok: false,
    rates: { attempted: 0, succeeded: 0, failed: 1, skipped: 0, failures: [] },
    reputation: { attempted: 0, succeeded: 0, failed: 0, failures: [] },
  })), { outcome: "failed", failureCode: "NO_EVIDENCE_PRODUCED" });
  assert.deepEqual(classifyRefreshRun(refreshResult({
    ok: false,
    reputation: { attempted: 3, succeeded: 2, failed: 1, failures: [] },
  })), { outcome: "partial", failureCode: "REPUTATION_FAILURES" });
});

test("status route requires the cron bearer secret and is uncached", async () => {
  assert.equal(statusRoute.dynamic, "force-dynamic");
  let reads = 0;
  const read = async () => {
    reads += 1;
    return evaluateRefreshWatchdog(seeded(), FIRST_SLOT, REFRESH_PIPELINE);
  };
  const denied = await getRefreshWatchdogResponse(
    new Request("http://localhost/api/internal/refresh/status"),
    { cronSecret: "secret", read },
  );
  assert.equal(denied.status, 401);
  assert.equal(reads, 0);

  const allowed = await getRefreshWatchdogResponse(
    new Request("http://localhost/api/internal/refresh/status", {
      headers: { authorization: "Bearer secret" },
    }),
    { cronSecret: "secret", read },
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json()).state, "awaiting_first_refresh");

  const failed = await getRefreshWatchdogResponse(
    new Request("http://localhost/api/internal/refresh/status", {
      headers: { authorization: "Bearer secret" },
    }),
    { cronSecret: "secret", read: async () => { throw new Error("DATABASE_URL=secret-value"); } },
  );
  assert.equal(failed.status, 500);
  assert.equal((await failed.text()).includes("secret-value"), false);
});

function at(value: string): Date {
  return new Date(value);
}

function shift(value: Date, ms: number): Date {
  return new Date(value.getTime() + ms);
}

function iso(value: Date): string {
  return value.toISOString();
}

function seeded(): RefreshWatchdogState {
  return Object.freeze({
    pipeline: REFRESH_PIPELINE,
    trackingSince: DEPLOYED_AT,
    lastRunId: null,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    lastRunOutcome: null,
    lastRunFailureCode: null,
    lastSuccessfulRefreshAt: null,
    consecutiveUnsuccessfulRuns: 0,
  });
}

function successState(completedAt: Date): RefreshWatchdogState {
  return applyRunCompleted(
    applyRunStarted(seeded(), REFRESH_PIPELINE, "run-ok", FIRST_SLOT),
    REFRESH_PIPELINE,
    { runId: "run-ok", startedAt: FIRST_SLOT, completedAt },
    { outcome: "successful", failureCode: null },
  );
}

function serialize(state: RefreshWatchdogState | null): string {
  return JSON.stringify(state);
}

function deserialize(value: string): RefreshWatchdogState | null {
  const parsed = JSON.parse(value) as Record<string, unknown> | null;
  if (!parsed) return null;
  const date = (key: string) => (parsed[key] ? new Date(parsed[key] as string) : null);
  return Object.freeze({
    ...(parsed as unknown as RefreshWatchdogState),
    trackingSince: date("trackingSince")!,
    lastRunStartedAt: date("lastRunStartedAt"),
    lastRunCompletedAt: date("lastRunCompletedAt"),
    lastSuccessfulRefreshAt: date("lastSuccessfulRefreshAt"),
  });
}

/**
 * Simulates a durable store: state crosses the boundary only as a serialized
 * string, so a second store over the same `durable` object is a restarted
 * process with no shared memory.
 */
function memoryStore(
  initial: RefreshWatchdogState | null,
  durable: { serialized: string } = { serialized: serialize(initial) },
) {
  let transitions = 0;
  const repository: RefreshWatchdogRepository = {
    read: async (pipeline) => {
      assert.equal(pipeline, REFRESH_PIPELINE);
      return deserialize(durable.serialized);
    },
    transition: async (pipeline, apply) => {
      assert.equal(pipeline, REFRESH_PIPELINE);
      transitions += 1;
      const next = apply(deserialize(durable.serialized));
      durable.serialized = serialize(next);
      return next;
    },
  };
  return {
    repository,
    state: () => deserialize(durable.serialized),
    transitions: () => transitions,
  };
}

async function status(store: ReturnType<typeof memoryStore>, now: Date) {
  return readRefreshWatchdogStatus({ repository: store.repository, now: () => now });
}

function watched(
  store: ReturnType<typeof memoryStore>,
  run: () => Promise<ScheduledRefreshResult>,
  clock: Date[],
) {
  const times = [...clock];
  return runWatchedScheduledRefresh({
    run,
    repository: store.repository,
    now: () => {
      const next = times.shift();
      assert.ok(next, "test clock exhausted");
      return next;
    },
    runId: (() => {
      let count = 0;
      return () => `run-${++count}-${clock[0]!.getTime()}`;
    })(),
  });
}

function successfulRun() {
  return async () => refreshResult();
}

function refreshResult(overrides: Partial<ScheduledRefreshResult> = {}): ScheduledRefreshResult {
  return Object.freeze({
    ok: true,
    startedAt: FIRST_SLOT.toISOString(),
    completedAt: FIRST_SLOT.toISOString(),
    rates: { attempted: 1, succeeded: 1, failed: 0, skipped: 0, failures: [] },
    reputation: { attempted: 3, succeeded: 3, failed: 0, failures: [] },
    ...overrides,
  });
}
