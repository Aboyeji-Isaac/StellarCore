import assert from "node:assert/strict";
import test from "node:test";

import { REPUTATION_WEIGHTS } from "@/constants/reputation";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  ReputationEvidence,
  ReputationTransferStatus,
} from "@/types/reputation";

const NOW = new Date("2026-08-31T12:00:00.000Z");

test("no evidence and status-only evidence remain insufficient", () => {
  const unknown = calculateReputation(evidence({ status: "UNKNOWN" }), NOW);
  const live = calculateReputation(evidence({ status: "LIVE" }), NOW);

  assert.equal(unknown.score, null);
  assert.equal(unknown.state, "insufficient_evidence");
  assert.equal(live.score, null);
  assert.equal(live.components.availability.score, 100);
  assert.equal(live.components.transferReliability.score, 0);
});

test("fresh, stale, and mixed corridor evidence reuse current freshness rules", () => {
  const fresh = calculateReputation(evidence({
    corridors: ["a"],
    rates: [{ corridorSlug: "a", ageMs: 120_000 }],
  }), NOW);
  const stale = calculateReputation(evidence({
    corridors: ["a"],
    rates: [{ corridorSlug: "a", ageMs: 120_001 }],
  }), NOW);
  const mixed = calculateReputation(evidence({
    corridors: ["a", "b"],
    rates: [
      { corridorSlug: "a", ageMs: 1 },
      { corridorSlug: "b", ageMs: 120_001 },
    ],
  }), NOW);

  assert.equal(fresh.evidence.freshRateCount, 1);
  assert.equal(fresh.components.rateFreshness.score, 100);
  assert.equal(stale.evidence.freshRateCount, 0);
  assert.equal(stale.components.rateFreshness.score, 0);
  assert.equal(mixed.components.rateFreshness.score, 50);
  assert.equal(mixed.components.coverage.score, 50);
});

test("transfer reliability treats only COMPLETED as success", () => {
  const successful = calculateReputation(establishedEvidence(outcomes(30, "COMPLETED")), NOW);
  const failed = calculateReputation(establishedEvidence(outcomes(30, "ERROR")), NOW);
  const mixed = calculateReputation(establishedEvidence([
    ...outcomes(15, "COMPLETED"),
    ...outcomes(15, "REFUNDED"),
  ]), NOW);

  assert.equal(successful.components.transferReliability.score, 100);
  assert.equal(successful.score, 100);
  assert.equal(successful.scoreBand, "GREEN");
  assert.equal(failed.components.transferReliability.score, 0);
  assert.equal(failed.score, 50);
  assert.equal(mixed.components.transferReliability.score, 50);
  assert.equal(mixed.score, 75);
});

test("minimum sample threshold separates sparse evidence from poor evidence", () => {
  const below = calculateReputation(establishedEvidence(outcomes(29, "COMPLETED")), NOW);
  const at = calculateReputation(establishedEvidence(outcomes(30, "ERROR")), NOW);

  assert.equal(below.state, "insufficient_evidence");
  assert.equal(below.score, null);
  assert.equal(at.state, "established");
  assert.equal(at.score, 50);
});

test("weights are exact, bounded, and deterministic rounding is half-up", () => {
  assert.deepEqual(REPUTATION_WEIGHTS, {
    availability: 20,
    rateFreshness: 15,
    coverage: 15,
    transferReliability: 50,
  });
  assert.equal(Object.values(REPUTATION_WEIGHTS).reduce((sum, value) => sum + value, 0), 100);

  const oneThird = calculateReputation(establishedEvidence([
    ...outcomes(10, "COMPLETED"),
    ...outcomes(20, "ERROR"),
  ]), NOW);
  assert.equal(oneThird.components.transferReliability.score, 33);
  assert.equal(oneThird.score, 67);
  assert.ok(oneThird.score! >= 0 && oneThird.score! <= 100);
  assert.deepEqual(oneThird, calculateReputation(establishedEvidence([
    ...outcomes(10, "COMPLETED"),
    ...outcomes(20, "ERROR"),
  ]), NOW));
});

test("results and nested evidence are immutable", () => {
  const result = calculateReputation(establishedEvidence(outcomes(30, "COMPLETED")), NOW);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.components), true);
  assert.equal(Object.isFrozen(result.components.coverage), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.metrics), true);
});

test("rolling metrics use deterministic success ratios and nearest-rank percentiles", () => {
  const history = outcomes(28, "ERROR");
  history.push(outcome("COMPLETED", 1, 1_000, 0.01));
  history.push(outcome("COMPLETED", 2, 3_000, 0.03));
  const result = calculateReputation(establishedEvidence(history), NOW);

  assert.equal(result.metrics.fillRate7d, 0.0667);
  assert.equal(result.metrics.fillRate30d, 0.0667);
  assert.equal(result.metrics.fillRate90d, 0.0667);
  assert.equal(result.metrics.settleP50Ms, 1_000);
  assert.equal(result.metrics.settleP95Ms, 3_000);
  assert.equal(result.metrics.slippageP50, 0.01);
  assert.equal(result.metrics.slippageP95, 0.03);
});

function establishedEvidence(
  transferOutcomes: ReputationEvidence["transferOutcomes"],
): ReputationEvidence {
  return evidence({
    status: "LIVE",
    corridors: ["corridor-a"],
    rates: [{ corridorSlug: "corridor-a", ageMs: 1_000 }],
    transferOutcomes,
  });
}

function evidence(options: {
  status?: ReputationEvidence["status"];
  corridors?: readonly string[];
  rates?: readonly Readonly<{ corridorSlug: string; ageMs: number }>[];
  transferOutcomes?: ReputationEvidence["transferOutcomes"];
}): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: options.status ?? "LIVE",
    corridorSlugs: Object.freeze([...(options.corridors ?? [])]),
    latestRates: Object.freeze((options.rates ?? []).map((rate) => Object.freeze({
      corridorSlug: rate.corridorSlug,
      capturedAt: new Date(NOW.getTime() - rate.ageMs),
    }))),
    transferOutcomes: Object.freeze([...(options.transferOutcomes ?? [])]),
  });
}

function outcomes(
  count: number,
  status: ReputationTransferStatus,
): ReputationEvidence["transferOutcomes"][number][] {
  return Array.from({ length: count }, (_, index) => outcome(status, index));
}

function outcome(
  status: ReputationTransferStatus,
  index: number,
  settlementMs = 1_000,
  slippage = 0,
): ReputationEvidence["transferOutcomes"][number] {
  return Object.freeze({
    status,
    settlementMs,
    slippage,
    recordedAt: new Date(NOW.getTime() - index * 1_000),
  });
}
