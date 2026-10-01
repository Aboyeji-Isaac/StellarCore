import assert from "node:assert/strict";
import test from "node:test";

import { watchdogPipelineLockQuery } from "@/lib/scheduled/watchdogRepository";

const ADVERSARIAL_VALUES = Object.freeze([
  "' OR 1=1--",
  "x'; DROP TABLE refresh_watchdog;--",
  "${identifier}",
  "\"; SELECT pg_sleep(10);--",
  "/* comment */ UNION SELECT null",
]);

test("watchdog pipeline lock query keeps adversarial pipeline ids bound", () => {
  const baseline = watchdogPipelineLockQuery("baseline");

  for (const value of ADVERSARIAL_VALUES) {
    const query = watchdogPipelineLockQuery(value);
    assert.equal(query.text, baseline.text);
    assert.deepEqual(query.values, [value]);
    assert.equal(query.text.includes(value), false);
  }
});
