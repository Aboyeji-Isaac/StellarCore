import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOutcomeMetric,
  parseOutcomeMetric,
} from "@/lib/reputation/outcomeMetrics";

test("fill rate accepts only exact decimals in the unit interval at scale 18", () => {
  assert.equal(normalizeOutcomeMetric("1.000000000000000000", "fillRate"), "1");
  assert.equal(normalizeOutcomeMetric("0.250000000000000000", "fillRate"), "0.25");
  assert.throws(() => parseOutcomeMetric("1.000000000000000001", "fillRate"));
  assert.throws(() => parseOutcomeMetric("-0.01", "fillRate"));
  assert.throws(() => parseOutcomeMetric("0.0000000000000000001", "fillRate"));
  assert.throws(() => parseOutcomeMetric("1e-3", "fillRate"));
});

test("slippage preserves signed NUMERIC(38,18) values without float conversion", () => {
  const exact = "10000000000000000.000000000000000001";
  assert.equal(normalizeOutcomeMetric(exact, "slippage"), exact);
  assert.equal(
    normalizeOutcomeMetric("-0.000000000000000001", "slippage"),
    "-0.000000000000000001",
  );
  assert.equal(
    normalizeOutcomeMetric("0.000000000000000001", "slippage"),
    "0.000000000000000001",
  );
  assert.equal(
    parseOutcomeMetric(exact, "slippage") + BigInt(1),
    parseOutcomeMetric("10000000000000000.000000000000000002", "slippage"),
  );
  assert.throws(() => parseOutcomeMetric("1.0000000000000000001", "slippage"));
  assert.throws(() => parseOutcomeMetric("100000000000000000000", "slippage"));
});