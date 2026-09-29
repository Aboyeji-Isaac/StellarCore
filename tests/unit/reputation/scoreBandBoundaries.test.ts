import assert from "node:assert/strict";
import test from "node:test";

import { REPUTATION_BANDS } from "@/constants/reputation";
import { calculateReputation } from "@/lib/reputation/score";
import type { ReputationEvidence } from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");

// Regression guard for the issue's "confirm the real current band cutoffs
// from source" instruction: these tests pin the cutoffs actually used by
// lib/reputation/score.ts. If the constants change, this assertion fails and
// the boundary cases below must be re-derived — old documentation numbers do
// not update silently.
test("band cutoffs in source are the ones these boundary tests pin", () => {
  assert.deepEqual(REPUTATION_BANDS, { greenMinimum: 95, amberMinimum: 80 });
  assert.equal(Object.isFrozen(REPUTATION_BANDS), true);
});

// Score derivation used below (from lib/reputation/score.ts, not docs):
//
//   composite = round_half_up(
//     (BP_availability * 20 + BP_rateFreshness * 15 + BP_coverage * 15
//       + BP_transferReliability * 50) / 10_000,
//   )
//
// With LIVE status, one fresh latest rate for the one corridor, and
// BP_transferReliability = round_half_up(10_000 * completed / total), this
// reduces to composite = 50 + BP_transferReliability / 200. Exact pairs:
//
//   44/50 completed -> BP 8_800 -> 94  (just below GREEN)
//   45/50 completed -> BP 9_000 -> 95  (exactly GREEN)
//   58/100 completed -> BP 5_800 -> 79 (just below AMBER)
//   60/100 completed -> BP 6_000 -> 80 (exactly AMBER)
test("score exactly at the green cutoff classifies GREEN, one point below is AMBER", () => {
  const atGreen = calculateReputation(establishedEvidence(45, 50), NOW);
  const belowGreen = calculateReputation(establishedEvidence(44, 50), NOW);

  assert.equal(atGreen.score, 95);
  assert.equal(atGreen.scoreBand, "GREEN");
  assert.equal(belowGreen.score, 94);
  assert.equal(belowGreen.scoreBand, "AMBER");
});

test("score exactly at the amber cutoff classifies AMBER, one point below is RED", () => {
  const atAmber = calculateReputation(establishedEvidence(60, 100), NOW);
  const belowAmber = calculateReputation(establishedEvidence(58, 100), NOW);

  assert.equal(atAmber.score, 80);
  assert.equal(atAmber.scoreBand, "AMBER");
  assert.equal(belowAmber.score, 79);
  assert.equal(belowAmber.scoreBand, "RED");
});

test("extreme scores stay inside their bands: 100 GREEN and 0 RED", () => {
  const perfect = calculateReputation(establishedEvidence(30, 30), NOW);
  const worst = calculateReputation(worstEvidence(), NOW);

  assert.equal(perfect.score, 100);
  assert.equal(perfect.scoreBand, "GREEN");
  assert.equal(worst.score, 0);
  assert.equal(worst.scoreBand, "RED");
});

test("mid-band samples do not leak across cutoffs", () => {
  const green = calculateReputation(establishedEvidence(47, 50), NOW);
  const amber = calculateReputation(establishedEvidence(35, 50), NOW);
  const red = calculateReputation(establishedEvidence(20, 100), NOW);

  assert.equal(green.score, 97);
  assert.equal(green.scoreBand, "GREEN");
  assert.equal(amber.score, 85);
  assert.equal(amber.scoreBand, "AMBER");
  assert.equal(red.score, 60);
  assert.equal(red.scoreBand, "RED");
});

test("bands are only classified when a score exists", () => {
  const sparse = calculateReputation(
    establishedEvidence(29, 29),
    NOW,
  );

  assert.equal(sparse.score, null);
  assert.equal(sparse.scoreBand, null);
});

function establishedEvidence(
  completedCount: number,
  totalOutcomes: number,
): ReputationEvidence {
  return evidence("LIVE", completedCount, totalOutcomes, 1_000);
}

// DOWN status plus all-failed outcomes plus a stale rate zeroes every
// component, pinning the RED band's lower bound at exactly 0.
function worstEvidence(): ReputationEvidence {
  return evidence("DOWN", 0, 30, 120_001);
}

function evidence(
  status: ReputationEvidence["status"],
  completedCount: number,
  totalOutcomes: number,
  rateAgeMs: number,
): ReputationEvidence {
  const failedCount = totalOutcomes - completedCount;

  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status,
    corridorSlugs: Object.freeze(["corridor"]),
    latestRates: Object.freeze([Object.freeze({
      corridorSlug: "corridor",
      capturedAt: new Date(NOW.getTime() - rateAgeMs),
    })]),
    transferOutcomes: Object.freeze([
      ...Array.from({ length: completedCount }, (_, index) =>
        outcome("COMPLETED", index)),
      ...Array.from({ length: failedCount }, (_, index) =>
        outcome("ERROR", completedCount + index)),
    ]),
  });
}

function outcome(
  status: ReputationEvidence["transferOutcomes"][number]["status"],
  index: number,
): ReputationEvidence["transferOutcomes"][number] {
  return Object.freeze({
    status,
    settlementMs: 1_000,
    slippage: 0,
    recordedAt: new Date(NOW.getTime() - index * 1_000),
  });
}
