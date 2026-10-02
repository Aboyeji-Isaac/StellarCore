import assert from "node:assert/strict";
import test from "node:test";

import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationEvidence,
  ReputationTransferStatus,
} from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function evidenceWith(
  transferOutcomes: ReadonlyArray<{
    status: ReputationTransferStatus;
    recordedAt: Date;
  }>,
): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: "LIVE",
    corridorSlugs: Object.freeze(["corridor"]),
    latestRates: Object.freeze([
      Object.freeze({ corridorSlug: "corridor", capturedAt: new Date(NOW.getTime() - 1_000) }),
    ]),
    transferOutcomes: Object.freeze(transferOutcomes.map((outcome) =>
      Object.freeze({
        status: outcome.status,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: new Date(outcome.recordedAt.getTime()),
      }))),
  });
}

test("an outcome recorded exactly now is counted while a future outcome is never counted", () => {
  const result = calculateReputation(evidenceWith([
    { status: "COMPLETED", recordedAt: NOW },
    { status: "COMPLETED", recordedAt: new Date(NOW.getTime() + 1) },
  ]), NOW);

  assert.equal(result.evidence.outcomeCount, 1);
  assert.equal(result.evidence.completedOutcomeCount, 1);
  assert.equal(result.metrics.fillRate7d, 1);
});

test("rolling window starts are inclusive at the exact boundary in each window", () => {
  const result = calculateReputation(evidenceWith([
    { status: "COMPLETED", recordedAt: new Date(NOW.getTime() - 7 * DAY_MS) },
    { status: "ERROR", recordedAt: new Date(NOW.getTime() - 7 * DAY_MS - 1) },
    { status: "COMPLETED", recordedAt: new Date(NOW.getTime() - 30 * DAY_MS) },
    { status: "ERROR", recordedAt: new Date(NOW.getTime() - 30 * DAY_MS - 1) },
  ]), NOW);

  // 7d: the exact boundary is included; one millisecond older is not.
  assert.equal(result.metrics.fillRate7d, 1);
  // 30d: both boundary observations are included (2 of 3 in-window completed).
  assert.equal(result.metrics.fillRate30d, 0.6667);
  // 90d spans all supplied outcomes.
  assert.equal(result.metrics.fillRate90d, 0.5);
});

test("the same controlled instant always produces the same window result", () => {
  const evidence = evidenceWith([
    { status: "COMPLETED", recordedAt: new Date(NOW.getTime() - 7 * DAY_MS) },
    { status: "REFUNDED", recordedAt: new Date(NOW.getTime() - 1_000) },
  ]);

  const first = calculateReputation(evidence, NOW);
  const second = calculateReputation(evidence, new Date(NOW.getTime()));
  assert.deepEqual(first.metrics, second.metrics);
  assert.deepEqual(first.evidence, second.evidence);
});
