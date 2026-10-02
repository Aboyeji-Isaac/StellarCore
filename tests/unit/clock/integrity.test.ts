import assert from "node:assert/strict";
import test from "node:test";

import { CLOCK_MAXIMUM_SKEW_MS } from "@/constants/clock";
import { createControlledClock } from "@/lib/clock/clock";
import {
  assessClockIntegrity,
  checkClockIntegrity,
} from "@/lib/clock/integrity";
import type {
  ClockIntegrityCheckRecord,
  DatabaseClockReader,
} from "@/types/clock";

const DATABASE_TIME = new Date("2026-08-31T12:00:00.000Z");

function assess(applicationTime: Date | null, databaseTime: Date | null) {
  return assessClockIntegrity({
    boundary: "RATE_CAPTURE",
    applicationTime,
    databaseTime,
    toleranceMs: CLOCK_MAXIMUM_SKEW_MS,
  });
}

test("matching clocks pass with a bounded, sanitized verdict", () => {
  const verdict = assess(DATABASE_TIME, DATABASE_TIME);
  assert.equal(verdict.outcome, "PASSED");
  assert.equal(verdict.code, null);
  assert.equal(verdict.skewMs, 0);
  assert.equal(verdict.direction, "NONE");
  assert.equal(verdict.applicationTime, DATABASE_TIME.toISOString());
  assert.equal(verdict.databaseTime, DATABASE_TIME.toISOString());
  assert.equal(Object.isFrozen(verdict), true);
  assert.doesNotThrow(() => JSON.stringify(verdict));
});

test("exact tolerance passes while one millisecond beyond fails in both directions", () => {
  const ahead = assess(
    new Date(DATABASE_TIME.getTime() + CLOCK_MAXIMUM_SKEW_MS),
    DATABASE_TIME,
  );
  assert.equal(ahead.outcome, "PASSED");

  const behind = assess(
    new Date(DATABASE_TIME.getTime() - CLOCK_MAXIMUM_SKEW_MS),
    DATABASE_TIME,
  );
  assert.equal(behind.outcome, "PASSED");

  const future = assess(
    new Date(DATABASE_TIME.getTime() + CLOCK_MAXIMUM_SKEW_MS + 1),
    DATABASE_TIME,
  );
  assert.equal(future.outcome, "REJECTED");
  assert.equal(future.code, "CLOCK_SKEW_EXCEEDED");
  assert.equal(future.direction, "POSITIVE");
  assert.equal(future.skewMs, CLOCK_MAXIMUM_SKEW_MS + 1);

  const lagging = assess(
    new Date(DATABASE_TIME.getTime() - CLOCK_MAXIMUM_SKEW_MS - 1),
    DATABASE_TIME,
  );
  assert.equal(lagging.outcome, "REJECTED");
  assert.equal(lagging.code, "CLOCK_SKEW_EXCEEDED");
  assert.equal(lagging.direction, "NEGATIVE");
  assert.equal(lagging.skewMs, -(CLOCK_MAXIMUM_SKEW_MS + 1));
});

test("pathological skew is clamped to the reviewed metadata bound", () => {
  const verdict = assess(new Date("3000-01-01T00:00:00.000Z"), DATABASE_TIME);
  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "CLOCK_SKEW_EXCEEDED");
  assert.equal(verdict.skewMs, 24 * 60 * 60 * 1_000);
  assert.equal(verdict.direction, "POSITIVE");
});

test("a missing clock read is rejected with a typed, negative-value-free result", () => {
  const verdict = assessClockIntegrity({
    boundary: "REPUTATION_EVALUATION",
    applicationTime: DATABASE_TIME,
    databaseTime: null,
    toleranceMs: CLOCK_MAXIMUM_SKEW_MS,
    readFailure: true,
  });
  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "CLOCK_READ_FAILURE");
  assert.equal(verdict.skewMs, null);
  assert.equal(verdict.direction, "UNKNOWN");
  assert.equal(verdict.applicationTime, null);
  assert.equal(verdict.databaseTime, null);
});

test("invalid instants are rejected rather than compared", () => {
  const verdict = assess(new Date(Number.NaN), DATABASE_TIME);
  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "INVALID_CLOCK_VALUE");
  assert.equal(verdict.applicationTime, null);
  assert.equal(verdict.databaseTime, DATABASE_TIME.toISOString());
});

test("the gate compares the controlled clock with PostgreSQL and records the run", async () => {
  const clock = createControlledClock(DATABASE_TIME);
  const recorded: ClockIntegrityCheckRecord[] = [];
  const verdict = await checkClockIntegrity("RATE_CAPTURE", {
    clock,
    reader: { readDatabaseTime: async () => DATABASE_TIME },
    recorder: { record: async (record) => { recorded.push(record); } },
    runId: "run-1",
  });

  assert.equal(verdict.outcome, "PASSED");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.outcome, "PASSED");
  assert.equal(recorded[0]?.runId, "run-1");
  assert.equal(recorded[0]?.boundary, "RATE_CAPTURE");
  assert.equal(recorded[0]?.skewMs, 0);
  assert.equal(recorded[0]?.applicationTime?.toISOString(), DATABASE_TIME.toISOString());
});

test("a skewed gate is recorded as a rejected provenance row", async () => {
  const recorded: ClockIntegrityCheckRecord[] = [];
  const verdict = await checkClockIntegrity("RATE_CAPTURE", {
    clock: createControlledClock(
      new Date(DATABASE_TIME.getTime() - CLOCK_MAXIMUM_SKEW_MS - 1),
    ),
    reader: { readDatabaseTime: async () => DATABASE_TIME },
    recorder: { record: async (record) => { recorded.push(record); } },
  });

  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "CLOCK_SKEW_EXCEEDED");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.outcome, "REJECTED");
  assert.equal(recorded[0]?.code, "CLOCK_SKEW_EXCEEDED");
});

test("an invalid application instant is not recorded rather than violating the time-pair constraint", async () => {
  let recorded = false;
  const verdict = await checkClockIntegrity("RATE_CAPTURE", {
    clock: { now: () => new Date(Number.NaN) },
    reader: { readDatabaseTime: async () => DATABASE_TIME },
    recorder: { record: async () => { recorded = true; } },
  });

  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "INVALID_CLOCK_VALUE");
  assert.equal(recorded, false);
});

test("a failed database clock read is rejected without attempting to record", async () => {
  let recorded = false;
  const reader: DatabaseClockReader = {
    readDatabaseTime: async () => {
      throw new Error("connection refused");
    },
  };
  const verdict = await checkClockIntegrity("REPUTATION_EVALUATION", {
    clock: createControlledClock(DATABASE_TIME),
    reader,
    recorder: { record: async () => { recorded = true; } },
  });

  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "CLOCK_READ_FAILURE");
  assert.equal(recorded, false);
  assert.equal(JSON.stringify(verdict).includes("connection refused"), false);
});

test("a passed check whose metadata cannot be persisted fails closed", async () => {
  const verdict = await checkClockIntegrity("RATE_CAPTURE", {
    clock: createControlledClock(DATABASE_TIME),
    reader: { readDatabaseTime: async () => DATABASE_TIME },
    recorder: {
      record: async () => {
        throw new Error("insert failed for secret reasons");
      },
    },
  });

  assert.equal(verdict.outcome, "REJECTED");
  assert.equal(verdict.code, "CLOCK_METADATA_PERSISTENCE_FAILURE");
  assert.equal(JSON.stringify(verdict).includes("secret"), false);
});
