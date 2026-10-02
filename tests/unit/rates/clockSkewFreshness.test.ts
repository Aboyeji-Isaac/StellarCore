import assert from "node:assert/strict";
import test from "node:test";

import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import { computeFreshMedian } from "@/lib/rates/median";
import { getRateFreshness } from "@/lib/rates/freshness";

const TRUSTED_NOW = new Date("2026-08-31T12:00:00.000Z");

test("a future observation from a forward-skewed clock is never fresh", () => {
  // Even one millisecond ahead is `future`, regardless of how much of the
  // 120-second window remains.
  for (const aheadMs of [1, 60_000, RATE_FRESHNESS_THRESHOLD_MS, 3_600_000]) {
    const freshness = getRateFreshness(
      new Date(TRUSTED_NOW.getTime() + aheadMs),
      TRUSTED_NOW,
    );
    assert.equal(freshness.state, "future");
    assert.notEqual(freshness.state, "fresh");
  }
});

test("the window is measured against the shared clock, not extended by skew", () => {
  assert.equal(
    getRateFreshness(
      new Date(TRUSTED_NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS),
      TRUSTED_NOW,
    ).state,
    "fresh",
  );
  assert.equal(
    getRateFreshness(
      new Date(TRUSTED_NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS - 1),
      TRUSTED_NOW,
    ).state,
    "stale",
  );
});

test("a forward-skewed persisted observation is excluded from the fresh median", () => {
  const future = new Date(TRUSTED_NOW.getTime() + 30_000);
  const fresh = new Date(TRUSTED_NOW.getTime() - 1_000);
  const result = computeFreshMedian([
    { anchorSlug: "future", corridorSlug: "usdc-us-usd-us", rate: "100", capturedAt: future },
    { anchorSlug: "fresh", corridorSlug: "usdc-us-usd-us", rate: "200", capturedAt: fresh },
  ], TRUSTED_NOW);

  const futureSource = result.sources.find(({ anchorSlug }) => anchorSlug === "future");
  assert.equal(futureSource?.included, false);
  assert.equal(futureSource?.exclusionReason, "future_timestamp");
  assert.equal(result.freshSourceCount, 1);
  assert.equal(result.state, "insufficient_fresh_sources");
});

test("identical persisted timestamps order deterministically across a backward clock step", () => {
  // A backward clock step can make a later capture carry an earlier timestamp.
  // Ordering is by capturedAt then snapshot id, so the same inputs always
  // produce the same result.
  const backward = new Date(TRUSTED_NOW.getTime() - 2_000);
  const result = computeFreshMedian([
    { anchorSlug: "a", corridorSlug: "usdc-us-usd-us", rate: "100", capturedAt: backward },
    { anchorSlug: "b", corridorSlug: "usdc-us-usd-us", rate: "300", capturedAt: backward },
  ], TRUSTED_NOW);

  assert.equal(result.state, "healthy");
  assert.equal(result.median, "200");
});
