import assert from "node:assert/strict";
import test from "node:test";

import { calculateReputation } from "@/lib/reputation/score";
import type { ReputationEvidence } from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");

test("established scores reach but never exceed exact lower and upper bounds", () => {
  assert.equal(calculateReputation(evidence("DOWN", "ERROR", 120_001), NOW).score, 0);
  assert.equal(calculateReputation(evidence("LIVE", "COMPLETED", 0), NOW).score, 100);
});

function evidence(
  status: ReputationEvidence["status"],
  outcomeStatus: "COMPLETED" | "ERROR",
  rateAgeMs: number,
): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status,
    corridorSlugs: Object.freeze(["corridor"]),
    latestRates: Object.freeze([Object.freeze({
      corridorSlug: "corridor",
      capturedAt: new Date(NOW.getTime() - rateAgeMs),
    })]),
    transferOutcomes: Object.freeze(Array.from({ length: 30 }, (_, index) =>
      Object.freeze({
        status: outcomeStatus,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: new Date(NOW.getTime() - index),
      }))),
  });
}
