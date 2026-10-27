import assert from "node:assert/strict";
import test from "node:test";

import { MIN_REPUTATION_OUTCOMES } from "@/constants/reputation";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationAnchorStatus,
  ReputationEvidence,
  ReputationTransferStatus,
} from "@/types/reputation";

const NOW = new Date("2026-09-01T12:00:00.000Z");
const SNAPSHOT = Object.freeze({
  snapshotId: "100:5:",
  readAt: NOW,
  isolationLevel: "REPEATABLE READ" as const,
});

test("an anchor with no optional evidence is unscored and exposes null metrics", () => {
  for (const { status, availabilityScore } of [
    { status: "LIVE", availabilityScore: 100 },
    { status: "DEGRADED", availabilityScore: 50 },
    { status: "DOWN", availabilityScore: 0 },
    { status: "UNKNOWN", availabilityScore: 0 },
  ] as const) {
    const result = calculateReputation(evidence({ status }), NOW);

    assert.equal(result.state, "insufficient_evidence", status);
    assert.equal(result.score, null, status);
    assert.equal(result.scoreBand, null, status);
    assert.deepEqual(result.components.availability, {
      weight: 20,
      score: availabilityScore,
      earnedPoints: availabilityScore * 20 / 100,
    }, status);
    assert.equal(result.components.rateFreshness.score, 0, status);
    assert.equal(result.components.coverage.score, 0, status);
    assert.equal(result.components.transferReliability.score, 0, status);
    assert.deepEqual(result.evidence, {
      corridorCount: 0,
      latestRateCount: 0,
      freshRateCount: 0,
      outcomeCount: 0,
      completedOutcomeCount: 0,
      minimumOutcomeCount: MIN_REPUTATION_OUTCOMES,
    }, status);
    assert.deepEqual(result.metrics, {
      fillRate7d: null,
      fillRate30d: null,
      fillRate90d: null,
      settleP50Ms: null,
      settleP95Ms: null,
      slippageP50: null,
      slippageP95: null,
    }, status);
    // A positive availability component alone must never become a score.
    assert.equal(result.scoreBand, null, status);
  }
});

test("a complete outcome history stays unscored when rates or corridors are absent", () => {
  const noRates = calculateReputation(evidence({
    corridors: ["corridor-a"],
    outcomes: repeatedOutcomes(30, "COMPLETED"),
  }), NOW);
  const noCorridors = calculateReputation(evidence({
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: repeatedOutcomes(30, "COMPLETED"),
  }), NOW);
  const noOutcomes = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
  }), NOW);

  for (const result of [noRates, noCorridors, noOutcomes]) {
    assert.equal(result.state, "insufficient_evidence");
    assert.equal(result.score, null);
    assert.equal(result.scoreBand, null);
  }

  assert.equal(noRates.evidence.outcomeCount, 30);
  assert.equal(noRates.evidence.latestRateCount, 0);
  assert.equal(noRates.components.rateFreshness.score, 0);
  assert.equal(noRates.components.coverage.score, 0);

  assert.equal(noCorridors.evidence.corridorCount, 0);
  assert.equal(noCorridors.evidence.latestRateCount, 0);
  assert.equal(noCorridors.components.coverage.score, 0);

  assert.equal(noOutcomes.evidence.outcomeCount, 0);
  assert.equal(noOutcomes.components.transferReliability.score, 0);
});

test("rates for corridors the anchor does not serve are omitted, not counted as fresh", () => {
  const result = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-unrelated", capturedAt: NOW }],
    outcomes: repeatedOutcomes(30, "COMPLETED"),
  }), NOW);

  assert.equal(result.state, "insufficient_evidence");
  assert.equal(result.score, null);
  assert.equal(result.evidence.corridorCount, 1);
  assert.equal(result.evidence.latestRateCount, 0);
  assert.equal(result.evidence.freshRateCount, 0);
  assert.equal(result.components.rateFreshness.score, 0);
  assert.equal(result.components.coverage.score, 0);
});

test("unavailable rate timestamps are present but never treated as fresh", () => {
  for (const capturedAt of ["not-a-date", new Date(Number.NaN)]) {
    const result = calculateReputation(evidence({
      corridors: ["corridor-a"],
      rates: [{ corridorSlug: "corridor-a", capturedAt }],
      outcomes: repeatedOutcomes(30, "COMPLETED"),
    }), NOW);

    assert.equal(result.state, "established");
    assert.equal(result.evidence.latestRateCount, 1);
    assert.equal(result.evidence.freshRateCount, 0);
    assert.equal(result.components.rateFreshness.score, 0);
    assert.equal(result.components.coverage.score, 0);
    // Availability only (20) plus transfer reliability (50).
    assert.equal(result.score, 70);
    assert.equal(result.scoreBand, "RED");
  }
});

test("an unavailable latest capture never displaces a valid fresh rate", () => {
  const invalid = { corridorSlug: "corridor-a", capturedAt: "not-a-date" };
  const fresh = { corridorSlug: "corridor-a", capturedAt: NOW };

  for (const rates of [[invalid, fresh], [fresh, invalid]]) {
    const result = calculateReputation(evidence({
      corridors: ["corridor-a"],
      rates,
      outcomes: repeatedOutcomes(30, "COMPLETED"),
    }), NOW);

    assert.equal(result.evidence.latestRateCount, 1);
    assert.equal(result.evidence.freshRateCount, 1);
    assert.equal(result.components.rateFreshness.score, 100);
    assert.equal(result.score, 100);
  }
});

test("outcomes with invalid or future timestamps are omitted from the sample", () => {
  const invalidTimestamp = outcome("COMPLETED", "not-a-date");
  const futureTimestamp = outcome(
    "COMPLETED",
    new Date(NOW.getTime() + 1_000),
  );

  const onlyTwentyNine = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: [...repeatedOutcomes(29, "COMPLETED"), invalidTimestamp],
  }), NOW);
  const twentyNinePlusFuture = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: [...repeatedOutcomes(29, "COMPLETED"), futureTimestamp],
  }), NOW);
  const thirtyPlusInvalid = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: [...repeatedOutcomes(30, "COMPLETED"), invalidTimestamp],
  }), NOW);

  // Unavailable timestamps must not pad the sample up to the 30-row minimum.
  assert.equal(onlyTwentyNine.evidence.outcomeCount, 29);
  assert.equal(onlyTwentyNine.state, "insufficient_evidence");
  assert.equal(onlyTwentyNine.score, null);
  assert.equal(onlyTwentyNine.metrics.fillRate90d, 1);

  assert.equal(twentyNinePlusFuture.evidence.outcomeCount, 29);
  assert.equal(twentyNinePlusFuture.state, "insufficient_evidence");
  assert.equal(twentyNinePlusFuture.score, null);

  // Nor may they be recorded as failed transfers once the sample is established.
  assert.equal(thirtyPlusInvalid.evidence.outcomeCount, 30);
  assert.equal(thirtyPlusInvalid.evidence.completedOutcomeCount, 30);
  assert.equal(thirtyPlusInvalid.components.transferReliability.score, 100);
  assert.equal(thirtyPlusInvalid.score, 100);
});

test("missing settlement and slippage signals yield null percentiles without hiding fill rates", () => {
  const unavailable = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: repeatedOutcomes(30, "COMPLETED").map((entry) =>
      Object.freeze({ ...entry, settlementMs: Number.NaN, slippage: Number.NaN })),
  }), NOW);

  assert.equal(unavailable.state, "established");
  assert.equal(unavailable.score, 100);
  assert.equal(unavailable.metrics.fillRate7d, 1);
  assert.equal(unavailable.metrics.fillRate30d, 1);
  assert.equal(unavailable.metrics.fillRate90d, 1);
  assert.equal(unavailable.metrics.settleP50Ms, null);
  assert.equal(unavailable.metrics.settleP95Ms, null);
  assert.equal(unavailable.metrics.slippageP50, null);
  assert.equal(unavailable.metrics.slippageP95, null);

  const partial = calculateReputation(evidence({
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: [
      ...repeatedOutcomes(27, "ERROR"),
      outcome("COMPLETED", NOW, 1_000, 0.01),
      outcome("COMPLETED", NOW, Number.NaN, Number.NaN),
      outcome("COMPLETED", NOW, 3_000, 0.03),
    ],
  }), NOW);

  assert.equal(partial.state, "established");
  assert.equal(partial.metrics.fillRate7d, 0.1);
  // Percentiles drop non-finite optional values instead of propagating NaN.
  assert.equal(partial.metrics.settleP50Ms, 1_000);
  assert.equal(partial.metrics.settleP95Ms, 3_000);
  assert.equal(partial.metrics.slippageP50, 0.01);
  assert.equal(partial.metrics.slippageP95, 0.03);
  for (const value of Object.values(partial.metrics)) {
    assert.ok(value === null || Number.isFinite(value));
  }
});

test("partial coverage rounds deterministically and stays inside 0..100", () => {
  const build = () => evidence({
    status: "DEGRADED",
    corridors: ["corridor-a", "corridor-b"],
    rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }],
    outcomes: [
      ...repeatedOutcomes(15, "COMPLETED"),
      ...repeatedOutcomes(15, "ERROR"),
    ],
  });

  const result = calculateReputation(build(), NOW);

  assert.equal(result.state, "established");
  assert.equal(result.evidence.corridorCount, 2);
  assert.equal(result.evidence.latestRateCount, 1);
  assert.equal(result.evidence.freshRateCount, 1);
  assert.equal(result.evidence.outcomeCount, 30);
  assert.equal(result.components.transferReliability.score, 50);
  assert.equal(result.components.rateFreshness.score, 100);
  assert.equal(result.components.coverage.score, 50);
  assert.equal(result.score, 58);
  assert.equal(result.scoreBand, "RED");
  assert.ok(Number.isInteger(result.score));

  assert.deepEqual(result, calculateReputation(build(), NOW));
});

test("partial input fixtures are bounded, deterministic, and never invent positive evidence", () => {
  const fixtures: readonly Readonly<{ name: string; evidence: ReputationEvidence }>[] = [
    { name: "empty", evidence: evidence({ status: "UNKNOWN" }) },
    {
      name: "corridors-only",
      evidence: evidence({ corridors: ["corridor-a", "corridor-b"] }),
    },
    {
      name: "rates-without-corridors",
      evidence: evidence({ rates: [{ corridorSlug: "corridor-a", capturedAt: NOW }] }),
    },
    {
      name: "outcomes-without-rates",
      evidence: evidence({
        corridors: ["corridor-a"],
        outcomes: repeatedOutcomes(29, "COMPLETED"),
      }),
    },
    {
      name: "invalid-timestamps",
      evidence: evidence({
        corridors: ["corridor-a"],
        rates: [{ corridorSlug: "corridor-a", capturedAt: "not-a-date" }],
        outcomes: [outcome("COMPLETED", "not-a-date")],
      }),
    },
  ];

  for (const fixture of fixtures) {
    const first = calculateReputation(fixture.evidence, NOW);
    const second = calculateReputation(fixture.evidence, NOW);

    assert.deepEqual(first, second, fixture.name);
    assert.equal(first.score, null, fixture.name);
    assert.equal(first.scoreBand, null, fixture.name);
    assert.equal(first.state, "insufficient_evidence", fixture.name);
    for (const component of Object.values(first.components)) {
      assert.ok(Number.isInteger(component.score), fixture.name);
      assert.ok(component.score >= 0 && component.score <= 100, fixture.name);
      assert.ok(Number.isInteger(component.earnedPoints), fixture.name);
    }
    for (const value of Object.values(first.metrics)) {
      assert.ok(value === null || Number.isFinite(value), fixture.name);
    }
  }
});

test("an invalid evaluation time throws instead of scoring missing evidence", () => {
  for (const invalid of [new Date(Number.NaN), new Date("invalid")]) {
    assert.throws(
      () => calculateReputation(evidence({ status: "LIVE" }), invalid),
      /Invalid reputation evaluation time/,
    );
  }
});

function evidence(options: {
  status?: ReputationAnchorStatus;
  corridors?: readonly string[];
  rates?: readonly Readonly<{ corridorSlug: string; capturedAt: Date | string }>[];
  outcomes?: ReputationEvidence["transferOutcomes"];
}): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: options.status ?? "LIVE",
    corridorSlugs: Object.freeze([...(options.corridors ?? [])]),
    latestRates: Object.freeze((options.rates ?? []).map((rate) => Object.freeze({
      corridorSlug: rate.corridorSlug,
      capturedAt: rate.capturedAt,
    }))),
    transferOutcomes: Object.freeze([...(options.outcomes ?? [])]),
    snapshot: SNAPSHOT,
  });
}

function repeatedOutcomes(
  count: number,
  status: ReputationTransferStatus,
): ReputationEvidence["transferOutcomes"][number][] {
  return Array.from({ length: count }, (_, index) =>
    outcome(status, new Date(NOW.getTime() - index * 1_000)));
}

function outcome(
  status: ReputationTransferStatus,
  recordedAt: Date | string,
  settlementMs = 1_000,
  slippage = 0,
): ReputationEvidence["transferOutcomes"][number] {
  return Object.freeze({ status, settlementMs, slippage, recordedAt });
}
