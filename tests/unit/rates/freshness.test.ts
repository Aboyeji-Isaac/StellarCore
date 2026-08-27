import assert from "node:assert/strict";
import test from "node:test";

import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import { getRateFreshness } from "@/lib/rates/freshness";

const NOW = new Date("2026-08-27T12:00:00.000Z");

test("freshness includes the exact threshold and identifies stale, future, and invalid times", () => {
  assert.deepEqual(getRateFreshness(new Date(NOW.getTime() - 1), NOW), {
    state: "fresh",
    ageMs: 1,
  });
  assert.equal(
    getRateFreshness(new Date(NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS), NOW).state,
    "fresh",
  );
  assert.equal(
    getRateFreshness(new Date(NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS - 1), NOW).state,
    "stale",
  );
  assert.equal(getRateFreshness(new Date(NOW.getTime() + 1), NOW).state, "future");
  assert.deepEqual(getRateFreshness("not-a-time", NOW), {
    state: "invalid",
    ageMs: null,
  });
});
