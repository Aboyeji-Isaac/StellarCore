import assert from "node:assert/strict";
import test from "node:test";

import { serializeRates } from "@/lib/api/rates";
import { serializeRateHistory } from "@/lib/api/rateHistory";
import { serializeReputation } from "@/lib/api/reputation";
import type { LatestCorridorRate, LatestRateSourceObservation } from "@/types/latestRates";
import type { CorridorRateHistory } from "@/types/rateHistory";
import type { ReputationApiAnchorRecord } from "@/lib/api/reputationRepository";

const CORRIDOR = "usdc-us-brl-br";
const NOW = "2026-08-28T12:00:00.000Z";
const CAPTURED_AT = "2026-08-28T11:59:59.000Z";

/**
 * Decimal(38,18) boundaries plus values whose shortest binary representation
 * differs from the persisted decimal, which is exactly what a `Number`
 * round-trip would silently replace.
 */
const MAX_DECIMAL = "99999999999999999999.999999999999999999";
const MIN_NONZERO_DECIMAL = "0.000000000000000001";
const PRECISION_SENSITIVE = [
  "0.100000000000000001",
  "0.170000000000000001",
  "12345678901234567890.123456789012345678",
  MIN_NONZERO_DECIMAL,
  MAX_DECIMAL,
] as const;
const DOCUMENTED_MEDIAN = "0.1000000000000000015";

function observation(
  anchorSlug: string,
  decimal: string,
  overrides: Partial<LatestRateSourceObservation> = {},
): LatestRateSourceObservation {
  return Object.freeze({
    snapshotId: `${anchorSlug}-snapshot`,
    anchorSlug,
    anchorName: `${anchorSlug} persisted`,
    rate: decimal,
    sourceAmount: decimal,
    destinationAmount: decimal,
    fee: decimal,
    capturedAt: CAPTURED_AT,
    freshnessState: "fresh",
    ageMs: 1_000,
    included: true,
    ...overrides,
  });
}

function latestRate(
  observations: readonly LatestRateSourceObservation[],
  median: string | null,
): LatestCorridorRate {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    evaluatedAt: NOW,
    state: median === null ? "insufficient_fresh_sources" : "healthy",
    median,
    totalIndependentSources: observations.length,
    freshSourceCount: observations.filter(({ included }) => included).length,
    observations: Object.freeze([...observations]),
    exclusions: Object.freeze(observations.filter(({ included }) => !included)),
  });
}

function history(points: CorridorRateHistory["points"]): CorridorRateHistory {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: NOW,
    windowDays: 30,
    points,
  });
}

test("rate evidence preserves Decimal(38,18) boundaries as exact strings", () => {
  const observations = PRECISION_SENSITIVE.map((decimal, index) =>
    observation(`anchor-${index}`, decimal),
  );
  const body = serializeRates(latestRate(observations, DOCUMENTED_MEDIAN));

  assert.equal(body.medianRate, DOCUMENTED_MEDIAN);
  assert.equal(body.observations.length, PRECISION_SENSITIVE.length);
  for (const [index, decimal] of PRECISION_SENSITIVE.entries()) {
    const serialized = body.observations[index]!;
    assert.equal(serialized.rate, decimal, `rate ${decimal}`);
    assert.equal(serialized.sourceAmount, decimal, `sourceAmount ${decimal}`);
    assert.equal(serialized.destinationAmount, decimal, `destinationAmount ${decimal}`);
    assert.equal(serialized.fee, decimal, `fee ${decimal}`);
    for (const field of ["rate", "sourceAmount", "destinationAmount", "fee"] as const) {
      assert.equal(
        typeof serialized[field],
        "string",
        `${field} must stay a string so it cannot enter binary floating point`,
      );
    }
  }
});

test("decimal fixtures actually expose the binary rounding a Number conversion would introduce", () => {
  for (const decimal of PRECISION_SENSITIVE) {
    assert.notEqual(
      String(Number(decimal)),
      decimal,
      `${decimal} must be precision sensitive for this suite to prove anything`,
    );
  }
});

test("JSON output stays valid, deterministic, and unrounded at decimal boundaries", () => {
  const input = latestRate(
    PRECISION_SENSITIVE.map((decimal, index) => observation(`anchor-${index}`, decimal)),
    MAX_DECIMAL,
  );
  const first = JSON.stringify(serializeRates(input));
  const second = JSON.stringify(serializeRates(input));
  assert.equal(first, second, "repeated serialization must be byte-identical");

  const parsed = JSON.parse(first) as {
    medianRate: string;
    observations: { rate: string }[];
  };
  assert.equal(parsed.medianRate, MAX_DECIMAL);
  assert.deepEqual(
    parsed.observations.map(({ rate }) => rate),
    [...PRECISION_SENSITIVE],
  );
  for (const decimal of PRECISION_SENSITIVE) {
    assert.ok(
      first.includes(`"${decimal}"`),
      `${decimal} must appear as a quoted string, never as a rounded number`,
    );
  }
  assert.equal(first.includes(MAX_DECIMAL), true);
  assert.equal(first.includes("null"), false, "no decimal may degrade to null");
});

test("history points preserve exact decimals and documented null medians", () => {
  const points: CorridorRateHistory["points"] = Object.freeze([
    Object.freeze({
      timestamp: "2026-08-28T11:59:00.000Z",
      medianRate: null,
      state: "insufficient_fresh_sources",
      sourceCount: 2,
      freshSourceCount: 1,
      observations: Object.freeze([
        Object.freeze({
          anchorSlug: "zeam",
          anchorName: "Zeam",
          rate: MIN_NONZERO_DECIMAL,
          sourceAmount: MAX_DECIMAL,
          destinationAmount: PRECISION_SENSITIVE[0],
          fee: "0",
          capturedAt: CAPTURED_AT,
        }),
      ]),
    }),
    Object.freeze({
      timestamp: "2026-08-28T12:00:00.000Z",
      medianRate: DOCUMENTED_MEDIAN,
      state: "healthy",
      sourceCount: 1,
      freshSourceCount: 1,
      observations: Object.freeze([
        Object.freeze({
          anchorSlug: "zeam",
          anchorName: "Zeam",
          rate: PRECISION_SENSITIVE[1],
          sourceAmount: PRECISION_SENSITIVE[2],
          destinationAmount: PRECISION_SENSITIVE[3],
          fee: PRECISION_SENSITIVE[4],
          capturedAt: CAPTURED_AT,
        }),
      ]),
    }),
  ]);

  const body = serializeRateHistory(history(points));
  assert.equal(body.points[0]?.medianRate, null);
  assert.equal(body.points[1]?.medianRate, DOCUMENTED_MEDIAN);

  const [firstObservation] = body.points[0]!.observations;
  assert.equal(firstObservation?.rate, MIN_NONZERO_DECIMAL);
  assert.equal(firstObservation?.sourceAmount, MAX_DECIMAL);
  assert.equal(firstObservation?.destinationAmount, PRECISION_SENSITIVE[0]);
  assert.equal(firstObservation?.fee, "0");

  const [secondObservation] = body.points[1]!.observations;
  assert.equal(secondObservation?.rate, PRECISION_SENSITIVE[1]);
  assert.equal(secondObservation?.sourceAmount, PRECISION_SENSITIVE[2]);
  assert.equal(secondObservation?.destinationAmount, PRECISION_SENSITIVE[3]);
  assert.equal(secondObservation?.fee, PRECISION_SENSITIVE[4]);
  for (const observation of body.points.flatMap(({ observations }) => observations)) {
    for (const field of ["rate", "sourceAmount", "destinationAmount", "fee"] as const) {
      assert.equal(typeof observation[field], "string");
    }
  }

  const serialized = JSON.stringify(body);
  assert.equal(serialized, JSON.stringify(serializeRateHistory(history(points))));
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test("persisted reputation metrics stay finite JSON numbers instead of invalid tokens", () => {
  const record: ReputationApiAnchorRecord = Object.freeze({
    slug: "zeam",
    name: "Zeam",
    reputationScore: Object.freeze({
      compositeScore: 99.999999,
      scoreBand: "GREEN",
      fillRate7d: Number.NaN,
      fillRate30d: Number.POSITIVE_INFINITY,
      fillRate90d: 0.123456789,
      settleP50Ms: 1_234,
      settleP95Ms: Number.NEGATIVE_INFINITY,
      slippageP50: 0.000000000000000001,
      slippageP95: Number.MAX_VALUE,
      sampleSize: 42,
      state: "OK",
      computedAt: new Date(CAPTURED_AT),
    }),
  });

  const serialized = serializeReputation(record);
  assert.equal(serialized.score, 99.999999);
  assert.equal(serialized.metrics?.fillRate7d, null);
  assert.equal(serialized.metrics?.fillRate30d, null);
  assert.equal(serialized.metrics?.settleP95Ms, null);
  assert.equal(serialized.metrics?.fillRate90d, 0.123456789);
  assert.equal(serialized.metrics?.slippageP50, 0.000000000000000001);

  const json = JSON.stringify(serialized);
  assert.doesNotThrow(() => JSON.parse(json));
  assert.equal(json.includes("Infinity"), false);
  assert.equal(json.includes("NaN"), false);
  assert.deepEqual(JSON.parse(json).metrics, {
    fillRate7d: null,
    fillRate30d: null,
    fillRate90d: 0.123456789,
    settleP50Ms: 1_234,
    settleP95Ms: null,
    slippageP50: 0.000000000000000001,
    slippageP95: Number.MAX_VALUE,
  });
});
