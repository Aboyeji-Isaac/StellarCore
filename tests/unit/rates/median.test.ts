import assert from "node:assert/strict";
import test from "node:test";

import { computeFreshMedian } from "@/lib/rates/median";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 1_000);

function source(anchorSlug: string, rate: string, capturedAt: Date | string = FRESH) {
  return { anchorSlug, corridorSlug: "usdc-us-usd-us", rate, capturedAt };
}

test("median handles two-source, odd, and exact even decimal cases", () => {
  assert.equal(computeFreshMedian([source("a", "1"), source("b", "2")], NOW).median, "1.5");
  assert.equal(
    computeFreshMedian([source("a", "10"), source("b", "2"), source("c", "3")], NOW).median,
    "3",
  );
  assert.equal(
    computeFreshMedian([source("a", "0.100000000000000001"), source("b", "0.100000000000000002")], NOW).median,
    "0.1000000000000000015",
  );
});

test("median excludes stale, future, invalid-time, and invalid-rate sources with metadata", () => {
  const result = computeFreshMedian([
    source("good-a", "1"),
    source("good-b", "3"),
    source("stale", "100", new Date(NOW.getTime() - 120_001)),
    source("future", "100", new Date(NOW.getTime() + 1)),
    source("bad-time", "100", "invalid"),
    source("bad-rate", "1e3"),
  ], NOW);

  assert.equal(result.state, "healthy");
  assert.equal(result.median, "2");
  assert.equal(result.freshSourceCount, 2);
  assert.deepEqual(
    result.sources.filter((entry) => !entry.included).map((entry) => entry.exclusionReason),
    ["stale", "future_timestamp", "invalid_timestamp", "invalid_rate"],
  );
});

test("fewer than two fresh valid sources returns no median", () => {
  const result = computeFreshMedian([source("only", "1"), source("zero", "0")], NOW);
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
  assert.equal(result.freshSourceCount, 1);
});
