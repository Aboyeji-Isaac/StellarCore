import assert from "node:assert/strict";
import test from "node:test";

import {
  createControlledClock,
  isValidClockInstant,
  SYSTEM_CLOCK,
} from "@/lib/clock/clock";

test("the system clock returns fresh independent instants", () => {
  const first = SYSTEM_CLOCK.now();
  const second = SYSTEM_CLOCK.now();
  assert.equal(first instanceof Date, true);
  assert.equal(Number.isFinite(first.getTime()), true);
  assert.equal(second instanceof Date, true);
  assert.notEqual(first, second);
});

test("a controlled clock advances, moves backward, and never mutates callers", () => {
  const clock = createControlledClock(new Date("2026-08-31T12:00:00.000Z"));
  const first = clock.now();
  clock.advance(5_000);
  assert.equal(clock.now().toISOString(), "2026-08-31T12:00:05.000Z");

  clock.set(new Date("2026-08-31T11:59:00.000Z"));
  assert.equal(clock.now().toISOString(), "2026-08-31T11:59:00.000Z");

  // Callers cannot mutate the clock's internal instant through the returned date.
  first.setTime(0);
  assert.equal(clock.now().toISOString(), "2026-08-31T11:59:00.000Z");
});

test("clock instants are validated explicitly", () => {
  assert.equal(isValidClockInstant(new Date("2026-08-31T12:00:00.000Z")), true);
  assert.equal(isValidClockInstant(new Date(Number.NaN)), false);
  assert.equal(isValidClockInstant(null), false);
  assert.equal(isValidClockInstant(undefined), false);
});
