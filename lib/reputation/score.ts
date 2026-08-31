import {
  MIN_REPUTATION_OUTCOMES,
  REPUTATION_BANDS,
  REPUTATION_METRICS_WINDOW_DAYS,
  REPUTATION_WEIGHTS,
} from "@/constants/reputation";
import { getRateFreshness } from "@/lib/rates/freshness";
import type {
  ReputationCalculation,
  ReputationComponent,
  ReputationEvidence,
  ReputationTransferStatus,
} from "@/types/reputation";

const BASIS_POINTS = BigInt(10_000);
const DAYS_TO_MS = 24 * 60 * 60 * 1_000;

export function calculateReputation(
  input: ReputationEvidence,
  evaluatedAt: Date,
): ReputationCalculation {
  if (!Number.isFinite(evaluatedAt.getTime())) {
    throw new Error("Invalid reputation evaluation time");
  }

  const corridorSlugs = new Set(input.corridorSlugs);
  const latestRates = selectLatestPerCorridor(input.latestRates)
    .filter(({ corridorSlug }) => corridorSlugs.has(corridorSlug));
  const freshRateCount = latestRates.filter(({ capturedAt }) =>
    getRateFreshness(capturedAt, evaluatedAt).state === "fresh").length;
  const outcomes = input.transferOutcomes.filter(({ recordedAt }) => {
    const time = timestamp(recordedAt);
    return time !== null && time <= evaluatedAt.getTime();
  });
  const completedOutcomeCount = outcomes.filter(({ status }) =>
    status === "COMPLETED").length;

  const availabilityBasisPoints = availabilityScore(input.status) * 100;
  const rateFreshnessBasisPoints = ratioBasisPoints(
    freshRateCount,
    latestRates.length,
  );
  const coverageBasisPoints = ratioBasisPoints(
    freshRateCount,
    corridorSlugs.size,
  );
  const reliabilityBasisPoints = ratioBasisPoints(
    completedOutcomeCount,
    outcomes.length,
  );

  const components = Object.freeze({
    availability: component(
      REPUTATION_WEIGHTS.availability,
      availabilityBasisPoints,
    ),
    rateFreshness: component(
      REPUTATION_WEIGHTS.rateFreshness,
      rateFreshnessBasisPoints,
    ),
    coverage: component(
      REPUTATION_WEIGHTS.coverage,
      coverageBasisPoints,
    ),
    transferReliability: component(
      REPUTATION_WEIGHTS.transferReliability,
      reliabilityBasisPoints,
    ),
  });

  const established = outcomes.length >= MIN_REPUTATION_OUTCOMES
    && corridorSlugs.size > 0
    && latestRates.length > 0;
  const score = established
    ? roundDiv(
        BigInt(availabilityBasisPoints) * BigInt(REPUTATION_WEIGHTS.availability)
          + BigInt(rateFreshnessBasisPoints) * BigInt(REPUTATION_WEIGHTS.rateFreshness)
          + BigInt(coverageBasisPoints) * BigInt(REPUTATION_WEIGHTS.coverage)
          + BigInt(reliabilityBasisPoints)
            * BigInt(REPUTATION_WEIGHTS.transferReliability),
        BASIS_POINTS,
      )
    : null;

  return Object.freeze({
    anchorSlug: input.anchorSlug,
    computedAt: evaluatedAt.toISOString(),
    state: established ? "established" : "insufficient_evidence",
    score,
    scoreBand: score === null ? null : scoreBand(score),
    components,
    evidence: Object.freeze({
      corridorCount: corridorSlugs.size,
      latestRateCount: latestRates.length,
      freshRateCount,
      outcomeCount: outcomes.length,
      completedOutcomeCount,
      minimumOutcomeCount: MIN_REPUTATION_OUTCOMES,
    }),
    metrics: calculateMetrics(outcomes, evaluatedAt),
  });
}

function availabilityScore(status: ReputationEvidence["status"]): number {
  if (status === "LIVE") return 100;
  if (status === "DEGRADED") return 50;
  return 0;
}

function component(weight: number, scoreBasisPoints: number): ReputationComponent {
  return Object.freeze({
    weight,
    score: basisPointsToInteger(scoreBasisPoints),
    earnedPoints: roundDiv(
      BigInt(scoreBasisPoints) * BigInt(weight),
      BASIS_POINTS,
    ),
  });
}

function ratioBasisPoints(numerator: number, denominator: number): number {
  if (denominator <= 0 || numerator <= 0) return 0;
  return roundDiv(BigInt(numerator) * BASIS_POINTS, BigInt(denominator));
}

function basisPointsToInteger(value: number): number {
  return roundDiv(BigInt(value), BigInt(100));
}

function roundDiv(numerator: bigint, denominator: bigint): number {
  return Number((numerator + denominator / BigInt(2)) / denominator);
}

function scoreBand(score: number): "GREEN" | "AMBER" | "RED" {
  if (score >= REPUTATION_BANDS.greenMinimum) return "GREEN";
  return score >= REPUTATION_BANDS.amberMinimum ? "AMBER" : "RED";
}

function selectLatestPerCorridor(
  rates: ReputationEvidence["latestRates"],
): ReputationEvidence["latestRates"] {
  const latest = new Map<string, ReputationEvidence["latestRates"][number]>();
  for (const rate of rates) {
    const current = latest.get(rate.corridorSlug);
    if (!current || timestampOrMinimum(rate.capturedAt)
      > timestampOrMinimum(current.capturedAt)) {
      latest.set(rate.corridorSlug, rate);
    }
  }
  return Object.freeze([...latest.values()].sort((left, right) =>
    left.corridorSlug.localeCompare(right.corridorSlug)));
}

function calculateMetrics(
  outcomes: ReputationEvidence["transferOutcomes"],
  evaluatedAt: Date,
): ReputationCalculation["metrics"] {
  const sevenDayStart = evaluatedAt.getTime() - 7 * DAYS_TO_MS;
  const thirtyDayStart = evaluatedAt.getTime()
    - REPUTATION_METRICS_WINDOW_DAYS * DAYS_TO_MS;
  const inWindow = (start: number) => outcomes.filter(({ recordedAt }) =>
    (timestamp(recordedAt) ?? Number.NEGATIVE_INFINITY) >= start);
  const thirtyDayCompleted = inWindow(thirtyDayStart)
    .filter(({ status }) => status === "COMPLETED");

  return Object.freeze({
    fillRate7d: successRatio(inWindow(sevenDayStart)),
    fillRate30d: successRatio(inWindow(thirtyDayStart)),
    fillRate90d: successRatio(outcomes),
    settleP50Ms: percentile(
      thirtyDayCompleted.map(({ settlementMs }) => settlementMs),
      50,
    ),
    settleP95Ms: percentile(
      thirtyDayCompleted.map(({ settlementMs }) => settlementMs),
      95,
    ),
    slippageP50: percentile(
      thirtyDayCompleted.map(({ slippage }) => slippage),
      50,
    ),
    slippageP95: percentile(
      thirtyDayCompleted.map(({ slippage }) => slippage),
      95,
    ),
  });
}

function successRatio(
  outcomes: readonly Readonly<{ status: ReputationTransferStatus }>[],
): number | null {
  if (outcomes.length === 0) return null;
  const completed = outcomes.filter(({ status }) => status === "COMPLETED").length;
  return ratioBasisPoints(completed, outcomes.length) / 10_000;
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  const valid = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (valid.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * valid.length) - 1;
  return valid[Math.max(0, index)]!;
}

function timestamp(value: Date | string): number | null {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function timestampOrMinimum(value: Date | string): number {
  return timestamp(value) ?? Number.NEGATIVE_INFINITY;
}
