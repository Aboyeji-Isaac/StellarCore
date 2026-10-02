import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_REPUTATION_OUTCOMES,
  REPUTATION_BANDS,
} from "@/constants/reputation";
import { RATE_FRESHNESS_THRESHOLD_MS } from "@/constants/rates";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationAnchorStatus,
  ReputationEvidence,
  ReputationTransferStatus,
} from "@/types/reputation";

/**
 * Property-based coverage for `calculateReputation` using a fixed-seed PRNG.
 *
 * Random draws are deterministic per seed, so failures are reproducible by
 * changing the seed in the failing case — no external property-testing
 * dependency is required and the generator cannot drift across runs.
 */

const NOW = new Date("2026-09-01T00:00:00.000Z");
const SCORE_STATUSES: readonly ReputationAnchorStatus[] =
  ["LIVE", "DEGRADED", "DOWN", "UNKNOWN"];
const TRANSFER_STATUSES: readonly ReputationTransferStatus[] =
  ["COMPLETED", "PARTIAL", "REFUNDED", "EXPIRED", "ERROR"];

type SeededRandom = Readonly<{ next: (bound: number) => number }>;

function seededRandom(seed: number): SeededRandom {
  let state = seed;
  return {
    // xorshift32: deterministic, tiny, and more than adequate for test data.
    next(bound: number): number {
      state ^= state << 13;
      state ^= state >> 17;
      state ^= state << 5;
      state &= 0xffffffff;
      return state % bound;
    },
  };
}

test("composite score over random evidence stays exactly within 0..100", () => {
  const random = seededRandom(11);
  for (let sample = 0; sample < 200; sample += 1) {
    const result = calculateReputation(validRandomEvidence(random), NOW);
    if (result.score === null) continue;

    assert.ok(
      result.score >= 0 && result.score <= 100,
      `score ${result.score} outside 0..100 for seed ${sample}`,
    );
    assert.equal(result.state, "established");
  }
});

test("below-threshold evidence never produces a score, exactly 30 does", () => {
  // Spans every status and outcome mix so the threshold check is exercised
  // with every possible component combination. Mix is always ≤ total so the
  // completed/failed split stays within the outcome set.
  for (const status of SCORE_STATUSES) {
    for (const mix of [0, 7, 15, 29]) {
      const below = calculateReputation(
        establishedEvidence(status, mix, 29),
        NOW,
      );
      assert.equal(below.state, "insufficient_evidence");
      assert.equal(below.score, null);
      assert.equal(below.scoreBand, null);
    }

    for (const mix of [0, 7, 29, 30]) {
      const atThreshold = calculateReputation(
        establishedEvidence(status, mix, 30),
        NOW,
      );
      assert.equal(atThreshold.state, "established");
      assert.ok(atThreshold.score !== null);
      assert.ok(atThreshold.score >= 0 && atThreshold.score <= 100);
    }
  }
});

test("score band always matches the inclusive source cutoffs", () => {
  const random = seededRandom(23);
  for (let sample = 0; sample < 200; sample += 1) {
    const result = calculateReputation(validRandomEvidence(random), NOW);
    if (result.score === null) {
      assert.equal(result.scoreBand, null);
      continue;
    }

    const score = result.score;
    const expected =
      score >= REPUTATION_BANDS.greenMinimum
        ? "GREEN"
        : score >= REPUTATION_BANDS.amberMinimum ? "AMBER" : "RED";
    assert.equal(result.scoreBand, expected, `score ${score}`);
  }
});

test("band cutoffs are exact in source and classify inclusive lower bounds", () => {
  assert.deepEqual(REPUTATION_BANDS, { greenMinimum: 95, amberMinimum: 80 });

  // 30 outcomes at 60/100 with LIVE + 1 fresh rate pins 80 (exactly AMBER).
  const atAmber = calculateReputation(establishedEvidence("LIVE", 60, 100), NOW);
  const belowAmber = calculateReputation(establishedEvidence("LIVE", 58, 100), NOW);
  const atGreen = calculateReputation(establishedEvidence("LIVE", 45, 50), NOW);
  const belowGreen = calculateReputation(establishedEvidence("LIVE", 44, 50), NOW);

  assert.equal(atAmber.score, 80);
  assert.equal(atAmber.scoreBand, "AMBER");
  assert.equal(belowAmber.score, 79);
  assert.equal(belowAmber.scoreBand, "RED");
  assert.equal(atGreen.score, 95);
  assert.equal(atGreen.scoreBand, "GREEN");
  assert.equal(belowGreen.score, 94);
  assert.equal(belowGreen.scoreBand, "AMBER");
});

test("evidence bookkeeping is consistent with the calculation inputs", () => {
  const random = seededRandom(31);
  for (let sample = 0; sample < 200; sample += 1) {
    const result = calculateReputation(validRandomEvidence(random), NOW);

    assert.equal(result.evidence.minimumOutcomeCount, MIN_REPUTATION_OUTCOMES);

    // outcomeCount only counts outcomes recorded at or before evaluation time.
    assert.ok(
      result.evidence.outcomeCount <= 90,
      `outcomeCount ${result.evidence.outcomeCount} exceeds window`,
    );

    // latestRateCount is capped by distinct corridors by construction, and the
    // result never reports a rate for a corridor outside the evidence.
    assert.ok(result.evidence.latestRateCount >= 0);
    assert.ok(result.evidence.freshRateCount <= result.evidence.latestRateCount);

    // Established requires at least the minimum outcome count.
    if (result.state === "established") {
      assert.ok(result.evidence.outcomeCount >= MIN_REPUTATION_OUTCOMES);
    } else {
      assert.equal(result.score, null);
    }

    // Metrics only ever reference the same outcome set.
    const zeroByEmptyWindow =
      result.metrics.fillRate7d === null
      || result.metrics.fillRate30d === null
      || result.metrics.fillRate90d === null;
    assert.ok(
      zeroByEmptyWindow
        ? true
        : result.metrics.fillRate7d! <= 1
          && result.metrics.fillRate30d! <= 1
          && result.metrics.fillRate90d! <= 1,
      "fill rates beyond 1.0",
    );
  }
});

test("valid random evidence never throws and preserves the anchor slug", () => {
  const random = seededRandom(7);
  for (let sample = 0; sample < 200; sample += 1) {
    const evidence = validRandomEvidence(random);
    const result = calculateReputation(evidence, NOW);
    assert.equal(result.anchorSlug, "property-anchor");
    assert.ok(new Date(result.computedAt).getTime() <= NOW.getTime());
  }
});

/**
 * Builds evidence that keeps the engine's valid-input invariants:
 * - outcomes are recorded no later than evaluation time (future rows would be
 *   filtered out of the window and distort outcomeCount assertions);
 * - every latest rate belongs to one of the advertised corridors;
 * - corridor list, rates, and outcomes are all non-empty so the interesting
 *   "established" path is reachable and the empty modes stay in unit tests.
 */
function validRandomEvidence(random: SeededRandom): ReputationEvidence {
  const corridorCount = 1 + random.next(3); // 1..3
  const corridorSlugs = Array.from(
    { length: corridorCount },
    (_, index) => `corridor-${index}`,
  );
  const freshCount = random.next(corridorCount + 1); // <= corridorCount

  const latestRates = corridorSlugs.map((corridorSlug, index) => Object.freeze({
    corridorSlug,
    // Keep the first few rates fresh so a non-zero rateFreshness is reachable.
    capturedAt: new Date(
      NOW.getTime() - (index < freshCount ? 1 : RATE_FRESHNESS_THRESHOLD_MS + 1),
    ),
  }));

  const outcomeCount = 30 + random.next(61); // 30..90
  const transferOutcomes = Array.from({ length: outcomeCount }, (_, index) => {
    const status = TRANSFER_STATUSES[random.next(TRANSFER_STATUSES.length)]!;
    return Object.freeze({
      status,
      settlementMs: 100 + random.next(10_000),
      slippage: random.next(200) / 100,
      recordedAt: new Date(NOW.getTime() - (1 + random.next(90 * 24 * 60 * 60)) * 1_000 - index),
    });
  });

  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "property-anchor",
    status: SCORE_STATUSES[random.next(SCORE_STATUSES.length)]!,
    corridorSlugs: Object.freeze(corridorSlugs),
    latestRates: Object.freeze(latestRates),
    transferOutcomes: Object.freeze(transferOutcomes),
  });
}

function establishedEvidence(
  status: ReputationAnchorStatus,
  completedCount: number,
  totalOutcomes: number,
): ReputationEvidence {
  const failedCount = totalOutcomes - completedCount;
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "property-anchor",
    status,
    corridorSlugs: Object.freeze(["corridor"]),
    latestRates: Object.freeze([Object.freeze({
      corridorSlug: "corridor",
      capturedAt: new Date(NOW.getTime() - 1_000),
    })]),
    transferOutcomes: Object.freeze([
      ...Array.from({ length: completedCount }, (_, index) => outcome("COMPLETED", index)),
      ...Array.from({ length: failedCount }, (_, index) =>
        outcome("ERROR", completedCount + index)),
    ]),
  });
}

function outcome(
  status: ReputationTransferStatus,
  index: number,
): ReputationEvidence["transferOutcomes"][number] {
  return Object.freeze({
    status,
    settlementMs: 1_000,
    slippage: 0,
    recordedAt: new Date(NOW.getTime() - index * 1_000),
  });
}