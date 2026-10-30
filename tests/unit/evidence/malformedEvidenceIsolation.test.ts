import assert from "node:assert/strict";
import test from "node:test";

import { MIN_REPUTATION_OUTCOMES } from "@/constants/reputation";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";
import {
  groupObservationsIntoSlices,
  readCorridorRateHistory,
} from "@/lib/rates/rateHistoryReadModel";
import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { calculateReputation } from "@/lib/reputation/score";
import type {
  LatestRateRepository,
  LatestRateRepositoryObservation,
} from "@/types/latestRates";
import type {
  RateHistoryRepository,
  RateHistoryRepositoryObservation,
} from "@/types/rateHistory";
import type {
  ReputationEvidence,
  ReputationRepository,
} from "@/types/reputation";

/**
 * Issue #346 (related #196): one corrupt persisted row must not poison an
 * entire read or reputation evaluation. These tests pin the existing contract
 * at the evidence-consumption boundary; they do not add any data repair.
 */

const NOW = new Date("2026-08-27T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";
const CORRIDOR_RECORD = Object.freeze({
  id: "corridor-id",
  slug: CORRIDOR,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
});

const BAD_TIMESTAMPS: readonly (Date | string)[] = [
  "not-a-time",
  "",
  "2026-13-45T00:00:00Z",
  new Date("invalid"),
];

const BAD_DECIMALS: readonly string[] = [
  "1e3",
  "abc",
  "",
  "-1",
  "1.",
  "NaN",
  "0x10",
  "1,5",
  " 1",
  "0",
  "0.1234567890123456789",
  `1${"0".repeat(20)}`,
];

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  assert.equal(result.ok, true);
  return result as Extract<T, { ok: true }>;
}

function ago(milliseconds: number): Date {
  return new Date(NOW.getTime() - milliseconds);
}

// ---------------------------------------------------------------------------
// Latest rate read model
// ---------------------------------------------------------------------------

function latestRow(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date | string,
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug} Persisted`,
    rate,
    sourceAmount: "100",
    destinationAmount: "10",
    fee: "0",
    capturedAt,
  });
}

function latestRepository(
  history: readonly LatestRateRepositoryObservation[],
): LatestRateRepository {
  return {
    findCorridorBySlug: async () => CORRIDOR_RECORD,
    findLatestObservations: async () => history,
  };
}

async function readLatest(history: readonly LatestRateRepositoryObservation[]) {
  return readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: latestRepository(history),
  });
}

test("latest read: every malformed timestamp shape is excluded as invalid_timestamp, never fresh", async () => {
  for (const [index, bad] of BAD_TIMESTAMPS.entries()) {
    const result = expectOk(await readLatest([
      latestRow("good-a", "a1", "1", ago(1)),
      latestRow("good-b", "b1", "3", ago(2)),
      latestRow("bad", `t${index}`, "2", bad),
    ]));
    const badObservation = result.observations.find(({ anchorSlug }) => anchorSlug === "bad");
    assert.equal(badObservation?.included, false, `variant ${index}`);
    assert.equal(badObservation?.exclusionReason, "invalid_timestamp", `variant ${index}`);
    assert.equal(badObservation?.freshnessState, "invalid", `variant ${index}`);
    assert.equal(badObservation?.ageMs, null, `variant ${index}`);
    assert.equal(result.freshSourceCount, 2, `variant ${index}`);
    assert.equal(result.median, "2", `variant ${index}`);
  }
});

test("latest read: every malformed decimal shape is excluded as invalid_rate without failing the read", async () => {
  for (const [index, bad] of BAD_DECIMALS.entries()) {
    const result = expectOk(await readLatest([
      latestRow("good-a", "a1", "1", ago(1)),
      latestRow("good-b", "b1", "3", ago(2)),
      latestRow("bad", `r${index}`, bad, ago(1)),
    ]));
    const badObservation = result.observations.find(({ anchorSlug }) => anchorSlug === "bad");
    assert.equal(badObservation?.included, false, `variant ${JSON.stringify(bad)}`);
    assert.equal(badObservation?.exclusionReason, "invalid_rate", `variant ${JSON.stringify(bad)}`);
    assert.equal(result.state, "healthy", `variant ${JSON.stringify(bad)}`);
    assert.equal(result.median, "2", `variant ${JSON.stringify(bad)}`);
    assert.equal(result.freshSourceCount, 2, `variant ${JSON.stringify(bad)}`);
  }
});

test("latest read: mixed valid and corrupt rows match the valid-only baseline", async () => {
  const validRows = [
    latestRow("a", "a1", "1", ago(1)),
    latestRow("b", "b1", "3", ago(2)),
  ];
  const baseline = expectOk(await readLatest(validRows));
  const mixed = expectOk(await readLatest([
    validRows[0]!,
    latestRow("bad-time", "t1", "2", "not-a-time"),
    validRows[1]!,
    latestRow("bad-rate", "r1", "1e3", ago(1)),
    latestRow("bad-both", "x1", "abc", "nope"),
  ]));

  assert.equal(mixed.state, baseline.state);
  assert.equal(mixed.median, baseline.median);
  assert.equal(mixed.freshSourceCount, baseline.freshSourceCount);
  assert.equal(mixed.totalIndependentSources, 5);
  assert.deepEqual(
    mixed.observations.filter(({ included }) => included),
    baseline.observations,
  );
  assert.deepEqual(
    mixed.exclusions.map(({ anchorSlug, exclusionReason }) => [anchorSlug, exclusionReason]),
    [
      ["bad-both", "invalid_timestamp"],
      ["bad-rate", "invalid_rate"],
      ["bad-time", "invalid_timestamp"],
    ],
  );
});

test("latest read: a corrupt newest row for an anchor never displaces a valid row", async () => {
  const result = expectOk(await readLatest([
    latestRow("a", "a-valid", "1", ago(1)),
    latestRow("a", "a-corrupt", "9", "not-a-time"),
    latestRow("b", "b1", "3", ago(2)),
  ]));
  assert.equal(result.totalIndependentSources, 2);
  assert.equal(result.observations[0]?.snapshotId, "a-valid");
  assert.equal(result.median, "2");
});

test("latest read: all-corrupt input is a safe typed insufficient state with a null median", async () => {
  const result = expectOk(await readLatest([
    latestRow("a", "a1", "1e3", ago(1)),
    latestRow("b", "b1", "2", "not-a-time"),
    latestRow("c", "c1", "abc", new Date("invalid")),
  ]));
  assert.equal(result.state, "insufficient_fresh_sources");
  assert.equal(result.median, null);
  assert.equal(result.freshSourceCount, 0);
  assert.equal(result.totalIndependentSources, 3);
  assert.equal(result.exclusions.length, 3);
  assert.equal(result.observations.every(({ included }) => !included), true);
});

test("latest read: failures are observable as codes without leaking raw row or error contents", async () => {
  const marker = "SECRET-TS-LATEST";
  const result = expectOk(await readLatest([
    latestRow("a", "a1", "1", ago(1)),
    latestRow("b", "b1", "3", ago(2)),
    latestRow("bad", "t1", "2", marker),
  ]));
  assert.equal(JSON.stringify(result).includes(marker), false);

  const failed = await readLatestCorridorRate(CORRIDOR, {
    evaluatedAt: NOW,
    repository: {
      findCorridorBySlug: async () => CORRIDOR_RECORD,
      findLatestObservations: async () => {
        throw new Error("DATABASE_URL=postgres://user:secret-latest@host/db");
      },
    },
  });
  assert.deepEqual(failed, { ok: false, corridorSlug: CORRIDOR, code: "READ_FAILURE" });
  assert.equal(JSON.stringify(failed).includes("secret-latest"), false);
});

// ---------------------------------------------------------------------------
// Rate history read model
// ---------------------------------------------------------------------------

const HISTORY_BASE = NOW.getTime() - 600_000;

function at(offsetMs: number): Date {
  return new Date(HISTORY_BASE + offsetMs);
}

function historyRow(
  anchorSlug: string,
  id: string,
  rate: string,
  capturedAt: Date | string,
): RateHistoryRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug} Persisted`,
    rate,
    sourceAmount: "100",
    destinationAmount: "10",
    fee: "0",
    capturedAt,
  });
}

function historyRepository(
  history: readonly RateHistoryRepositoryObservation[],
): RateHistoryRepository {
  return {
    findCorridorBySlug: async () => CORRIDOR_RECORD,
    findHistoryObservations: async () => history,
  };
}

async function readHistory(history: readonly RateHistoryRepositoryObservation[]) {
  return readCorridorRateHistory(CORRIDOR, {
    evaluatedAt: NOW,
    days: 30,
    repository: historyRepository(history),
  });
}

test("history: rows with a malformed timestamp are skipped and valid rows are unaffected", async () => {
  const validRows = [
    historyRow("a", "a1", "1", at(0)),
    historyRow("b", "b1", "3", at(1_000)),
  ];
  const baseline = expectOk(await readHistory(validRows));

  const slices = groupObservationsIntoSlices([
    validRows[0]!,
    historyRow("bad", "t0", "2", "not-a-time"),
    validRows[1]!,
  ]);
  assert.equal(slices.length, 1);
  assert.deepEqual(slices[0]?.map(({ id }) => id), ["a1", "b1"]);

  for (const [index, bad] of BAD_TIMESTAMPS.entries()) {
    const mixed = expectOk(await readHistory([
      validRows[0]!,
      historyRow("bad", `t${index}`, "2", bad),
      validRows[1]!,
    ]));
    assert.deepEqual(mixed.points, baseline.points, `variant ${index}`);
  }
});

test("history: a malformed decimal is excluded from the point median without dropping the point", async () => {
  const baseline = expectOk(await readHistory([
    historyRow("a", "a1", "1", at(0)),
    historyRow("b", "b1", "3", at(1_000)),
  ]));

  for (const bad of BAD_DECIMALS) {
    const mixed = expectOk(await readHistory([
      historyRow("a", "a1", "1", at(0)),
      historyRow("b", "b1", "3", at(1_000)),
      historyRow("c", "c1", bad, at(2_000)),
    ]));
    const point = mixed.points[0]!;
    assert.equal(mixed.points.length, 1, `variant ${JSON.stringify(bad)}`);
    assert.equal(point.medianRate, baseline.points[0]?.medianRate, `variant ${JSON.stringify(bad)}`);
    assert.equal(point.state, "healthy", `variant ${JSON.stringify(bad)}`);
    assert.equal(point.freshSourceCount, 2, `variant ${JSON.stringify(bad)}`);
    assert.equal(point.sourceCount, 3, `variant ${JSON.stringify(bad)}`);
  }
});

test("history: all-corrupt input returns a safe result with no median and no crash", async () => {
  const allBadTimestamps = expectOk(await readHistory([
    historyRow("a", "a1", "1", "not-a-time"),
    historyRow("b", "b1", "3", new Date("invalid")),
  ]));
  assert.equal(allBadTimestamps.points.length, 0);

  const allBadRates = expectOk(await readHistory([
    historyRow("a", "a1", "1e3", at(0)),
    historyRow("b", "b1", "abc", at(1_000)),
  ]));
  assert.equal(allBadRates.points.length, 1);
  assert.equal(allBadRates.points[0]?.state, "insufficient_fresh_sources");
  assert.equal(allBadRates.points[0]?.medianRate, null);
  assert.equal(allBadRates.points[0]?.freshSourceCount, 0);
});

test("history: failures expose only safe codes and corrupt timestamps are never echoed", async () => {
  const marker = "SECRET-TS-HISTORY";
  const result = expectOk(await readHistory([
    historyRow("a", "a1", "1", at(0)),
    historyRow("b", "b1", "3", at(1_000)),
    historyRow("bad", "t1", "2", marker),
  ]));
  assert.equal(JSON.stringify(result).includes(marker), false);

  const failed = await readCorridorRateHistory(CORRIDOR, {
    evaluatedAt: NOW,
    repository: {
      findCorridorBySlug: async () => CORRIDOR_RECORD,
      findHistoryObservations: async () => {
        throw new Error("DATABASE_URL=postgres://user:secret-history@host/db");
      },
    },
  });
  assert.deepEqual(failed, { ok: false, corridorSlug: CORRIDOR, code: "READ_FAILURE" });
  assert.equal(JSON.stringify(failed).includes("secret-history"), false);
});

// ---------------------------------------------------------------------------
// Reputation evidence
// ---------------------------------------------------------------------------

type Outcome = ReputationEvidence["transferOutcomes"][number];

function validOutcomes(count: number): Outcome[] {
  return Array.from({ length: count }, (_, index) => Object.freeze({
    status: "COMPLETED" as const,
    settlementMs: 1_000 + index * 10,
    slippage: 0.001 * (index + 1),
    recordedAt: new Date(NOW.getTime() - (index + 1) * 3_600_000),
  }));
}

function corruptTimestampOutcomes(): Outcome[] {
  return [
    Object.freeze({ status: "ERROR" as const, settlementMs: 500, slippage: 0, recordedAt: "not-a-time" }),
    Object.freeze({ status: "COMPLETED" as const, settlementMs: 500, slippage: 0, recordedAt: new Date("invalid") }),
    Object.freeze({ status: "ERROR" as const, settlementMs: 500, slippage: 0, recordedAt: "SECRET-ROW-VALUE" }),
  ];
}

function nonFiniteOutcomes(): Outcome[] {
  return [
    Object.freeze({
      status: "COMPLETED" as const,
      settlementMs: Number.NaN,
      slippage: Number.POSITIVE_INFINITY,
      recordedAt: new Date(NOW.getTime() - 60_000),
    }),
    Object.freeze({
      status: "COMPLETED" as const,
      settlementMs: Number.POSITIVE_INFINITY,
      slippage: Number.NaN,
      recordedAt: new Date(NOW.getTime() - 120_000),
    }),
  ];
}

function evidence(
  transferOutcomes: readonly Outcome[],
  latestRates: ReputationEvidence["latestRates"] = [
    Object.freeze({ corridorSlug: "c1", capturedAt: ago(1_000) }),
  ],
): ReputationEvidence {
  return Object.freeze({
    anchorId: "anchor-id",
    anchorSlug: "anchor",
    status: "LIVE" as const,
    corridorSlugs: Object.freeze(["c1"]),
    latestRates,
    transferOutcomes,
    snapshot: Object.freeze({
      snapshotId: "10:20:",
      readAt: NOW,
      isolationLevel: "REPEATABLE READ" as const,
    }),
  });
}

test("reputation: valid evidence is established and unchanged by the corruption tests' baseline", () => {
  const baseline = calculateReputation(evidence(validOutcomes(MIN_REPUTATION_OUTCOMES)), NOW);
  assert.equal(baseline.state, "established");
  assert.notEqual(baseline.score, null);
  assert.equal(baseline.evidence.outcomeCount, MIN_REPUTATION_OUTCOMES);
  assert.equal(baseline.evidence.freshRateCount, 1);
});

test("reputation: outcomes with a malformed recordedAt are ignored and never counted", () => {
  const valid = validOutcomes(MIN_REPUTATION_OUTCOMES);
  const baseline = calculateReputation(evidence(valid), NOW);
  const mixed = calculateReputation(
    evidence([...corruptTimestampOutcomes(), ...valid]),
    NOW,
  );

  assert.deepEqual(mixed.evidence, baseline.evidence);
  assert.equal(mixed.score, baseline.score);
  assert.equal(mixed.scoreBand, baseline.scoreBand);
  assert.equal(mixed.state, "established");
  assert.deepEqual(mixed.components, baseline.components);
  assert.deepEqual(mixed.metrics, baseline.metrics);
  assert.equal(JSON.stringify(mixed).includes("SECRET-ROW-VALUE"), false);
});

test("reputation: non-finite settlement and slippage values never poison percentile metrics", () => {
  const valid = validOutcomes(MIN_REPUTATION_OUTCOMES);
  const baseline = calculateReputation(evidence(valid), NOW);
  const mixed = calculateReputation(evidence([...valid, ...nonFiniteOutcomes()]), NOW);

  assert.equal(mixed.metrics.settleP50Ms, baseline.metrics.settleP50Ms);
  assert.equal(mixed.metrics.settleP95Ms, baseline.metrics.settleP95Ms);
  assert.equal(mixed.metrics.slippageP50, baseline.metrics.slippageP50);
  assert.equal(mixed.metrics.slippageP95, baseline.metrics.slippageP95);
  for (const value of Object.values(mixed.metrics)) {
    assert.equal(value === null || Number.isFinite(value), true);
  }
});

test("reputation: a malformed latest-rate capturedAt is never fresh and never beats a valid rate", () => {
  const valid = validOutcomes(MIN_REPUTATION_OUTCOMES);
  const withValidAndCorrupt = calculateReputation(evidence(valid, [
    Object.freeze({ corridorSlug: "c1", capturedAt: "not-a-time" }),
    Object.freeze({ corridorSlug: "c1", capturedAt: ago(1_000) }),
  ]), NOW);
  assert.equal(withValidAndCorrupt.evidence.latestRateCount, 1);
  assert.equal(withValidAndCorrupt.evidence.freshRateCount, 1);

  for (const bad of BAD_TIMESTAMPS) {
    const onlyCorrupt = calculateReputation(evidence(valid, [
      Object.freeze({ corridorSlug: "c1", capturedAt: bad }),
    ]), NOW);
    assert.equal(onlyCorrupt.evidence.freshRateCount, 0);
  }
});

test("reputation: all-corrupt outcomes yield insufficient evidence, a null score, and no throw", () => {
  const result = calculateReputation(evidence(corruptTimestampOutcomes()), NOW);
  assert.equal(result.state, "insufficient_evidence");
  assert.equal(result.score, null);
  assert.equal(result.scoreBand, null);
  assert.equal(result.evidence.outcomeCount, 0);
  assert.equal(result.metrics.fillRate90d, null);
  assert.equal(result.metrics.settleP50Ms, null);
  assert.equal(result.metrics.slippageP95, null);
});

function reputationRepository(
  overrides: Partial<ReputationRepository> = {},
): ReputationRepository {
  return {
    readEvidence: async () => evidence(validOutcomes(MIN_REPUTATION_OUTCOMES)),
    upsertScore: async ({ calculation }) => Object.freeze({
      id: "row-1",
      anchorSlug: calculation.anchorSlug,
      computedAt: new Date(calculation.computedAt),
      writeStatus: "written",
    }),
    ...overrides,
  };
}

test("reputation engine: corrupt rows do not fail the evaluation of valid evidence", async () => {
  const valid = validOutcomes(MIN_REPUTATION_OUTCOMES);
  const result = await evaluateAnchorReputation("anchor", {
    evaluatedAt: NOW,
    persist: false,
    repository: reputationRepository({
      readEvidence: async () => evidence([...corruptTimestampOutcomes(), ...valid, ...nonFiniteOutcomes()]),
    }),
  });
  const ok = expectOk(result);
  assert.equal(ok.calculation.state, "established");
});

test("reputation engine: read and persistence failures expose only safe codes", async () => {
  const readFailure = await evaluateAnchorReputation("anchor", {
    evaluatedAt: NOW,
    repository: reputationRepository({
      readEvidence: async () => {
        throw new Error("DATABASE_URL=postgres://user:secret-read@host/db");
      },
    }),
  });
  assert.deepEqual(readFailure, {
    ok: false,
    anchorSlug: "anchor",
    code: "EVIDENCE_READ_FAILURE",
  });
  assert.equal(JSON.stringify(readFailure).includes("secret-read"), false);

  const persistenceFailure = await evaluateAnchorReputation("anchor", {
    evaluatedAt: NOW,
    repository: reputationRepository({
      upsertScore: async () => {
        throw new Error("check constraint reputation_scores_secret_chk violated");
      },
    }),
  });
  assert.deepEqual(persistenceFailure, {
    ok: false,
    anchorSlug: "anchor",
    code: "PERSISTENCE_FAILURE",
  });
  assert.equal(JSON.stringify(persistenceFailure).includes("secret_chk"), false);
});
