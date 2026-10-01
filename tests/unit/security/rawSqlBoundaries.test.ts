import assert from "node:assert/strict";
import test from "node:test";

import { latestObservationsQuery } from "@/lib/rates/latestRateRepository";
import { latestCorridorRatesQuery } from "@/lib/reputation/repository";

const ADVERSARIAL_VALUES = Object.freeze([
  "' OR 1=1--",
  "x'; DROP TABLE rate_snapshots;--",
  "${identifier}",
  ""; SELECT pg_sleep(10);--",
  "/* comment */ UNION SELECT null",
]);

test("latest-observation raw queries keep adversarial values out of SQL text", () => {
  const baselineRates = latestObservationsQuery("baseline").text;
  const baselineReputation = latestCorridorRatesQuery("baseline").text;

  for (const value of ADVERSARIAL_VALUES) {
    const rates = latestObservationsQuery(value);
    assert.equal(rates.text, baselineRates);
    assert.deepEqual(rates.values, [value]);
    assert.equal(rates.text.includes(value), false);

    const reputation = latestCorridorRatesQuery(value);
    assert.equal(reputation.text, baselineReputation);
    assert.deepEqual(reputation.values, [value]);
    assert.equal(reputation.text.includes(value), false);
  }
});
