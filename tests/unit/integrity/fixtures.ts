import type {
  EvidenceIntegrityAuditSnapshot,
  EvidenceIntegrityViolationCode,
} from "@/types/integrity";

export const NOW = new Date("2026-09-30T12:00:00.000Z");

const MINUTE = 60_000;

/**
 * A fully coherent persisted evidence graph: one live anchor, a reviewed
 * membership, a positive rate snapshot, a valid transfer outcome, and a
 * published reputation score whose band matches its composite score. It is the
 * baseline that every corruption case is derived from, and it must audit with
 * zero findings.
 */
export function baseSnapshot(): EvidenceIntegrityAuditSnapshot {
  return Object.freeze({
    anchors: Object.freeze([
      Object.freeze({
        id: "anchor-a",
        slug: "anchor-a",
        status: "LIVE" as const,
        createdAt: new Date(NOW.getTime() - 24 * 60 * MINUTE),
      }),
    ]),
    corridors: Object.freeze([
      Object.freeze({
        id: "corridor-1",
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      }),
      Object.freeze({
        id: "corridor-2",
        slug: "usdc-us-kes-ke",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "KES",
        countryTo: "KE",
      }),
    ]),
    anchorCorridors: Object.freeze([
      Object.freeze({ anchorId: "anchor-a", corridorId: "corridor-1" }),
    ]),
    rateSnapshots: Object.freeze([
      Object.freeze({
        id: "rate-1",
        anchorId: "anchor-a",
        corridorId: "corridor-1",
        rate: "0.175",
        sourceAmount: "100",
        destinationAmount: "17.5",
        fee: "0.5",
        capturedAt: new Date(NOW.getTime() - MINUTE),
      }),
    ]),
    transferOutcomes: Object.freeze([
      Object.freeze({
        id: "outcome-1",
        anchorId: "anchor-a",
        corridorId: "corridor-1",
        status: "COMPLETED" as const,
        fillRate: 1,
        settlementMs: 1_200,
        slippage: 0,
        recordedAt: new Date(NOW.getTime() - MINUTE),
      }),
    ]),
    reputationScores: Object.freeze([
      Object.freeze({
        id: "score-1",
        anchorId: "anchor-a",
        compositeScore: 90,
        scoreBand: "AMBER" as const,
        fillRate7d: 0.99,
        fillRate30d: 0.98,
        fillRate90d: 0.97,
        settleP50Ms: 1_000,
        settleP95Ms: 2_000,
        slippageP50: 0,
        slippageP95: 0.01,
        sampleSize: 30,
        state: "OK" as const,
        computedAt: new Date(NOW.getTime() - MINUTE),
      }),
    ]),
  });
}

type SnapshotOverrides = Partial<EvidenceIntegrityAuditSnapshot>;

export function snapshotWith(overrides: SnapshotOverrides): EvidenceIntegrityAuditSnapshot {
  return Object.freeze({ ...baseSnapshot(), ...overrides });
}

export function corruption(
  code: EvidenceIntegrityViolationCode,
  overrides: SnapshotOverrides,
): Readonly<{
  code: EvidenceIntegrityViolationCode;
  snapshot: EvidenceIntegrityAuditSnapshot;
}> {
  return Object.freeze({ code, snapshot: snapshotWith(overrides) });
}

const baseRate = () => baseSnapshot().rateSnapshots[0]!;
const baseOutcome = () => baseSnapshot().transferOutcomes[0]!;
const baseScore = () => baseSnapshot().reputationScores[0]!;

/**
 * One deterministic fixture per documented violation class. Each case mutates
 * exactly one semantic aspect of the clean baseline so a failing test points
 * at one invariant.
 */
export const VIOLATION_CASES = Object.freeze([
  // Relationship drift.
  corruption("RATE_SNAPSHOT_MEMBERSHIP_MISSING", {
    rateSnapshots: [Object.freeze({ ...baseRate(), corridorId: "corridor-2" })],
  }),
  corruption("TRANSFER_OUTCOME_MEMBERSHIP_MISSING", {
    transferOutcomes: [Object.freeze({ ...baseOutcome(), corridorId: "corridor-2" })],
  }),
  corruption("DUPLICATE_CORRIDOR_SEMANTIC_IDENTITY", {
    corridors: [
      ...baseSnapshot().corridors,
      Object.freeze({
        id: "corridor-duplicate",
        slug: "usdc-us-brl-br-duplicate",
        assetCodeFrom: "usdc",
        countryFrom: "us",
        assetCodeTo: "brl",
        countryTo: "br",
      }),
    ],
  }),
  // Incompatible timestamps.
  corruption("RATE_SNAPSHOT_TIMESTAMP_FUTURE", {
    rateSnapshots: [
      Object.freeze({
        ...baseRate(),
        capturedAt: new Date(NOW.getTime() + 24 * 60 * MINUTE),
      }),
    ],
  }),
  corruption("RATE_SNAPSHOT_TIMESTAMP_BEFORE_ANCHOR", {
    rateSnapshots: [
      Object.freeze({
        ...baseRate(),
        capturedAt: new Date(NOW.getTime() - 48 * 60 * MINUTE),
      }),
    ],
  }),
  corruption("TRANSFER_OUTCOME_TIMESTAMP_FUTURE", {
    transferOutcomes: [
      Object.freeze({
        ...baseOutcome(),
        recordedAt: new Date(NOW.getTime() + 24 * 60 * MINUTE),
      }),
    ],
  }),
  corruption("TRANSFER_OUTCOME_TIMESTAMP_BEFORE_ANCHOR", {
    transferOutcomes: [
      Object.freeze({
        ...baseOutcome(),
        recordedAt: new Date(NOW.getTime() - 48 * 60 * MINUTE),
      }),
    ],
  }),
  corruption("REPUTATION_SCORE_TIMESTAMP_FUTURE", {
    reputationScores: [
      Object.freeze({
        ...baseScore(),
        computedAt: new Date(NOW.getTime() + 24 * 60 * MINUTE),
      }),
    ],
  }),
  corruption("REPUTATION_SCORE_TIMESTAMP_BEFORE_ANCHOR", {
    reputationScores: [
      Object.freeze({
        ...baseScore(),
        computedAt: new Date(NOW.getTime() - 48 * 60 * MINUTE),
      }),
    ],
  }),
  // Invalid score/evidence combinations.
  corruption("REPUTATION_STATE_OK_WITH_INSUFFICIENT_SAMPLE", {
    reputationScores: [Object.freeze({ ...baseScore(), sampleSize: 29 })],
  }),
  corruption("REPUTATION_STATE_OK_WITHOUT_COMPOSITE_SCORE", {
    reputationScores: [Object.freeze({ ...baseScore(), compositeScore: null })],
  }),
  corruption("REPUTATION_STATE_OK_WITHOUT_SCORE_BAND", {
    reputationScores: [Object.freeze({ ...baseScore(), scoreBand: null })],
  }),
  corruption("REPUTATION_INSUFFICIENT_DATA_WITH_SCORE", {
    reputationScores: [
      Object.freeze({ ...baseScore(), state: "INSUFFICIENT_DATA" as const }),
    ],
  }),
  corruption("REPUTATION_COMPOSITE_SCORE_OUT_OF_RANGE", {
    reputationScores: [
      Object.freeze({ ...baseScore(), compositeScore: 150, scoreBand: "GREEN" as const }),
    ],
  }),
  corruption("REPUTATION_SCORE_BAND_MISMATCH", {
    reputationScores: [Object.freeze({ ...baseScore(), scoreBand: "GREEN" as const })],
  }),
  corruption("REPUTATION_SAMPLE_SIZE_NEGATIVE", {
    reputationScores: [
      Object.freeze({
        ...baseScore(),
        state: "INSUFFICIENT_DATA" as const,
        compositeScore: null,
        scoreBand: null,
        sampleSize: -1,
      }),
    ],
  }),
  corruption("REPUTATION_FILL_RATE_OUT_OF_RANGE", {
    reputationScores: [Object.freeze({ ...baseScore(), fillRate7d: 2 })],
  }),
  corruption("REPUTATION_PERCENTILE_ORDER", {
    reputationScores: [
      Object.freeze({ ...baseScore(), settleP50Ms: 5_000, settleP95Ms: 1_000 }),
    ],
  }),
  corruption("REPUTATION_DURATION_NEGATIVE", {
    reputationScores: [
      Object.freeze({ ...baseScore(), settleP50Ms: -1, settleP95Ms: 1_000 }),
    ],
  }),
  // Invalid persisted evidence values.
  corruption("RATE_SNAPSHOT_NON_POSITIVE_AMOUNT", {
    rateSnapshots: [Object.freeze({ ...baseRate(), sourceAmount: "0" })],
  }),
  corruption("RATE_SNAPSHOT_NEGATIVE_FEE", {
    rateSnapshots: [Object.freeze({ ...baseRate(), fee: "-1" })],
  }),
  corruption("TRANSFER_OUTCOME_INVALID_METRIC", {
    transferOutcomes: [Object.freeze({ ...baseOutcome(), fillRate: Number.NaN })],
  }),
  corruption("TRANSFER_OUTCOME_NEGATIVE_SETTLEMENT", {
    transferOutcomes: [Object.freeze({ ...baseOutcome(), settlementMs: -1 })],
  }),
  corruption("TRANSFER_OUTCOME_FILL_RATE_OUT_OF_RANGE", {
    transferOutcomes: [Object.freeze({ ...baseOutcome(), fillRate: 2 })],
  }),
] as const);
