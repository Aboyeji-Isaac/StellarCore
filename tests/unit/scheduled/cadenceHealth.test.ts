import assert from "node:assert/strict";
import test from "node:test";

import {
  RATE_CAPTURE_MAX_INTERVAL_MS,
  RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
} from "@/constants/scheduling";
import {
  CAPTURE_CADENCE_NOT_EVIDENCE_OF,
  evaluateCaptureCadenceHealth,
} from "@/lib/scheduled/cadenceHealth";

const LAST_RUN = new Date("2026-08-31T16:00:00.000Z");
const INTERVAL_MS = 60_000;
const EXPECTED_BUDGET_MS = Math.min(
  INTERVAL_MS + RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS,
  RATE_CAPTURE_MAX_INTERVAL_MS,
);

test("no completed scheduled run is unknown, never healthy", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: null,
    scheduledIntervalMs: INTERVAL_MS,
    now: new Date("2026-08-31T16:05:00.000Z"),
  });

  assert.equal(health.state, "unknown");
  assert.equal(health.lastCompletedRunAt, null);
  assert.equal(health.ageMs, null);
  assert.equal(health.missedIntervals, null);
});

test("a run recorded without a planned interval stays unknown rather than guessed", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: LAST_RUN,
    scheduledIntervalMs: null,
    now: new Date("2026-08-31T16:05:00.000Z"),
  });

  assert.equal(health.state, "unknown");
  assert.equal(health.scheduledIntervalMs, null);
  assert.equal(health.lastCompletedRunAt, LAST_RUN.toISOString());
});

test("a cadence inside the jitter allowance is healthy", () => {
  for (const ageMs of [0, 1, INTERVAL_MS, EXPECTED_BUDGET_MS - 1, EXPECTED_BUDGET_MS]) {
    const health = evaluateCaptureCadenceHealth({
      lastCompletedRunAt: LAST_RUN,
      scheduledIntervalMs: INTERVAL_MS,
      now: new Date(LAST_RUN.getTime() + ageMs),
    });
    assert.equal(health.state, "healthy", `age ${ageMs}`);
    assert.equal(health.ageMs, ageMs);
    assert.equal(health.missedIntervals, 0);
  }
});

test("a delayed cadence is inside the freshness envelope but past the expected jitter", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: LAST_RUN,
    scheduledIntervalMs: INTERVAL_MS,
    now: new Date(LAST_RUN.getTime() + EXPECTED_BUDGET_MS + 1),
  });

  assert.equal(health.state, "delayed");
  assert.ok(health.ageMs! <= RATE_CAPTURE_MAX_INTERVAL_MS);
  assert.equal(health.missedIntervals, 1);
});

test("a missed cadence is reported beyond the maximum supported interval", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: LAST_RUN,
    scheduledIntervalMs: INTERVAL_MS,
    now: new Date(LAST_RUN.getTime() + RATE_CAPTURE_MAX_INTERVAL_MS + 1),
  });

  assert.equal(health.state, "missed");
  assert.equal(health.missedIntervals, 1);
});

test("missed intervals count the whole intervals the process did not observe", () => {
  const cases: ReadonlyArray<readonly [number, number]> = [
    [5 * INTERVAL_MS, 4],
    [5 * INTERVAL_MS + 1, 4],
    [10 * INTERVAL_MS, 9],
  ];

  for (const [ageMs, expected] of cases) {
    const health = evaluateCaptureCadenceHealth({
      lastCompletedRunAt: LAST_RUN,
      scheduledIntervalMs: INTERVAL_MS,
      now: new Date(LAST_RUN.getTime() + ageMs),
    });
    assert.equal(health.state, "missed", `age ${ageMs}`);
    assert.equal(health.missedIntervals, expected, `age ${ageMs}`);
  }
});

test("clock skew never manufactures a negative age or a fresh-looking run", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: LAST_RUN,
    scheduledIntervalMs: INTERVAL_MS,
    now: new Date(LAST_RUN.getTime() - 30_000),
  });

  assert.equal(health.state, "healthy");
  assert.equal(health.ageMs, 0);
});

test("an unparseable completion timestamp is unknown rather than healthy", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: "not-a-timestamp",
    scheduledIntervalMs: INTERVAL_MS,
    now: LAST_RUN,
  });

  assert.equal(health.state, "unknown");
  assert.equal(health.ageMs, null);
});

test("cadence health is scoped to the capture process and disclaims anchor health", () => {
  const health = evaluateCaptureCadenceHealth({
    lastCompletedRunAt: LAST_RUN,
    scheduledIntervalMs: INTERVAL_MS,
    now: new Date(LAST_RUN.getTime() + INTERVAL_MS),
  });

  assert.equal(health.signalScope, "stellarcore_capture_process");
  assert.equal(health.contractVersion, 1);
  assert.deepEqual([...health.notEvidenceOf], [...CAPTURE_CADENCE_NOT_EVIDENCE_OF]);
  for (const disclaimer of [
    "anchor_reachability",
    "price_or_quote_availability",
    "transfer_execution_success",
    "rate_freshness_or_median_eligibility",
  ]) {
    assert.ok(health.notEvidenceOf.includes(disclaimer), disclaimer);
  }

  // The payload carries no rate, median, or anchor-health field at all.
  assert.deepEqual(Object.keys(health).sort(), [
    "ageMs",
    "contractVersion",
    "lastCompletedRunAt",
    "missedIntervals",
    "notEvidenceOf",
    "scheduledIntervalMs",
    "signalScope",
    "state",
  ]);
  assert.equal(Object.isFrozen(health), true);
});
