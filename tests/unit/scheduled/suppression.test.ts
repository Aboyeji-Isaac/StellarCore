import assert from "node:assert/strict";
import test from "node:test";

import {
  advancePermanentSuppression,
  classifyPermanentScheduledFailure,
  PERMANENT_FAILURE_SUPPRESSION_THRESHOLD,
  reactivatePermanentSuppression,
} from "@/lib/scheduled/suppression";

test("only deterministic normalization failures are eligible for durable suppression", () => {
  assert.equal(
    classifyPermanentScheduledFailure({
      anchorSlug: "anchor-a",
      corridorSlug: "usdc-us-brl-br",
      phase: "NORMALIZATION",
      code: "ASSET_MISMATCH",
    }),
    "PERMANENT_PROTOCOL",
  );
  assert.equal(
    classifyPermanentScheduledFailure({
      anchorSlug: "anchor-a",
      corridorSlug: "usdc-us-brl-br",
      phase: "NORMALIZATION",
      code: "INVALID_CORRIDOR",
    }),
    "PERMANENT_CONFIGURATION",
  );

  for (const failure of [
    {
      anchorSlug: "anchor-a",
      corridorSlug: "usdc-us-brl-br",
      phase: "QUOTE" as const,
      code: "QUOTE_FAILURE",
    },
    {
      anchorSlug: "anchor-a",
      corridorSlug: "usdc-us-brl-br",
      phase: "PERSISTENCE" as const,
      code: "PERSISTENCE_FAILURE",
    },
  ]) {
    assert.equal(classifyPermanentScheduledFailure(failure), null);
  }
});

test("suppression activates only at the documented deterministic threshold", () => {
  const observedAt = new Date("2026-10-01T12:00:00.000Z");
  let state = null;

  for (let attempt = 1; attempt <= PERMANENT_FAILURE_SUPPRESSION_THRESHOLD; attempt += 1) {
    state = advancePermanentSuppression(state, observedAt);
    assert.equal(state.consecutiveFailures, attempt);
    assert.equal(
      state.state,
      attempt < PERMANENT_FAILURE_SUPPRESSION_THRESHOLD ? "ACTIVE" : "SUPPRESSED",
    );
  }

  assert.equal(state?.suppressedAt?.toISOString(), observedAt.toISOString());

  const repeated = advancePermanentSuppression(
    state,
    new Date("2026-10-01T12:05:00.000Z"),
  );
  assert.equal(repeated.state, "SUPPRESSED");
  assert.equal(
    repeated.consecutiveFailures,
    PERMANENT_FAILURE_SUPPRESSION_THRESHOLD,
  );
  assert.equal(
    repeated.suppressedAt?.toISOString(),
    observedAt.toISOString(),
  );
});

test("reviewed reactivation resets only suppression state", () => {
  assert.deepEqual(reactivatePermanentSuppression(), {
    state: "ACTIVE",
    consecutiveFailures: 0,
    suppressedAt: null,
  });
});
