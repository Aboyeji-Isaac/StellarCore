import assert from "node:assert/strict";
import test from "node:test";

import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import {
  getRateFreshness,
  isSuppressionEligible,
  type FailureClass,
  type PermanentFailureClass,
} from "@/lib/rates/freshness";

const NOW = new Date("2026-08-27T12:00:00.000Z");

function narrowedPermanentFailureClass(
  failureClass: FailureClass,
): PermanentFailureClass | null {
  return isSuppressionEligible(failureClass) ? failureClass : null;
}

test("only permanent failure classes are eligible for durable suppression", () => {
  for (const failureClass of [
    "invalid_configuration",
    "unsupported_protocol",
    "malformed_anchor",
    "invalid_source_reference",
  ] as const) {
    assert.equal(isSuppressionEligible(failureClass), true);
    assert.equal(narrowedPermanentFailureClass(failureClass), failureClass);
  }

  for (const failureClass of [
    "network_error",
    "timeout",
    "rate_limited",
    "upstream_unavailable",
    "transient_protocol_error",
  ] as const) {
    assert.equal(isSuppressionEligible(failureClass), false);
    assert.equal(narrowedPermanentFailureClass(failureClass), null);
  }
});

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

test("freshness boundary remains fresh one millisecond under and at the threshold", () => {
  assert.deepEqual(
    getRateFreshness(
      new Date(NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS + 1),
      NOW,
    ),
    { state: "fresh", ageMs: RATE_FRESHNESS_THRESHOLD_MS - 1 },
  );
  assert.deepEqual(
    getRateFreshness(
      new Date(NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS),
      NOW,
    ),
    { state: "fresh", ageMs: RATE_FRESHNESS_THRESHOLD_MS },
  );
});

test("freshness boundary becomes stale one millisecond over the threshold", () => {
  assert.deepEqual(
    getRateFreshness(
      new Date(NOW.getTime() - RATE_FRESHNESS_THRESHOLD_MS - 1),
      NOW,
    ),
    { state: "stale", ageMs: RATE_FRESHNESS_THRESHOLD_MS + 1 },
  );
});
