
import assert from "node:assert/strict";
import test from "node:test";

import { serializeRates } from "@/lib/api/rates";
import { serializeRateHistory } from "@/lib/api/rateHistory";
import type { LatestCorridorRate } from "@/types/latestRates";
import type { CorridorRateHistory } from "@/types/rateHistory";
import { serializeReputation } from "@/lib/api/reputation";
import type { ReputationApiAnchorRecord } from "@/lib/api/reputationRepository";

const CANONICAL_TIMESTAMP = "2026-08-28T12:00:00.000Z";
const CANONICAL_DATE = new Date(CANONICAL_TIMESTAMP);

// ---------------------------------------------------------------------------
// Timestamp serialization: consistent documented representation
// ---------------------------------------------------------------------------

test("serializeRates preserves capturedAt ISO-8601 strings verbatim", () => {
  const body = serializeRates(
    readResult({
      observations: [observation("zeam", CANONICAL_TIMESTAMP)],
    }),
  );

  assert.equal(body.observations[0]?.capturedAt, CANONICAL_TIMESTAMP);
  assert.equal(body.evaluatedAt, CANONICAL_TIMESTAMP);
});

test("serializeRateHistory preserves timestamp ISO-8601 strings verbatim", () => {
  const body = serializeRateHistory(
    readHistoryResult({
      points: [point(CANONICAL_TIMESTAMP, CANONICAL_TIMESTAMP)],
    }),
  );

  assert.equal(body.points[0]?.timestamp, CANONICAL_TIMESTAMP);
  assert.equal(body.evaluatedAt, CANONICAL_TIMESTAMP);
});

test("serializeReputation converts computedAt Date to ISO-8601 string", () => {
  const record: ReputationApiAnchorRecord = Object.freeze({
    slug: "zeam",
    name: "Zeam",
    reputationScore: Object.freeze({
      compositeScore: 95,
      scoreBand: "GREEN",
      fillRate7d: null,
      fillRate30d: null,
      fillRate90d: null,
      settleP50Ms: null,
      settleP95Ms: null,
      slippageP50: null,
      slippageP95: null,
      sampleSize: 30,
      state: "OK",
      computedAt: CANONICAL_DATE,
    }),
  });

  const value = serializeReputation(record);

  assert.equal(value.computedAt, CANONICAL_TIMESTAMP);
  assert.equal(typeof value.computedAt, "string");
});

test("serializeReputation keeps computedAt null when unevaluated", () => {
  const record: ReputationApiAnchorRecord = Object.freeze({
    slug: "moneygram",
    name: "MoneyGram",
    reputationScore: null,
  });

  const value = serializeReputation(record);

  assert.equal(value.computedAt, null);
});

test("stale evidence validates canonical timestamps via isCanonicalTimestamp", () => {
  assert.equal(Date.parse(CANONICAL_TIMESTAMP), CANONICAL_DATE.getTime());
  assert.equal(
    new Date(Date.parse(CANONICAL_TIMESTAMP)).toISOString(),
    CANONICAL_TIMESTAMP,
  );
});

// ---------------------------------------------------------------------------
// Decimal values: exact textual precision preservation
// ---------------------------------------------------------------------------

test("serializeRates preserves rate decimal strings exactly", () => {
  const body = serializeRates(
    readResult({
      median: "0.1000000000000000015",
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.100000000000000001",
        ),
      ],
    }),
  );

  assert.equal(body.medianRate, "0.1000000000000000015");
  assert.equal(
    body.observations[0]?.rate,
    "0.100000000000000001",
  );
});

test("serializeRates preserves sourceAmount decimal strings exactly", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.17",
          "100.000000000000000001",
        ),
      ],
    }),
  );

  assert.equal(
    body.observations[0]?.sourceAmount,
    "100.000000000000000001",
  );
});

test("serializeRates preserves destinationAmount decimal strings exactly", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.17",
          "100.000000000000000001",
          "17.000000000000000001",
        ),
      ],
    }),
  );

  assert.equal(
    body.observations[0]?.destinationAmount,
    "17.000000000000000001",
  );
});

test("serializeRates preserves fee decimal strings exactly", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.17",
          "100.000000000000000001",
          "17.000000000000000001",
          "1.000000000000000001",
        ),
      ],
    }),
  );

  assert.equal(
    body.observations[0]?.fee,
    "1.000000000000000001",
  );
});

test("serializeRateHistory preserves rate decimal strings exactly", () => {
  const body = serializeRateHistory(
    readHistoryResult({
      points: [
        point(CANONICAL_TIMESTAMP, CANONICAL_TIMESTAMP, "5.20"),
      ],
    }),
  );

  assert.equal(body.points[0]?.observations[0]?.rate, "5.20");
});

test("serializeRateHistory preserves medianRate decimal strings exactly", () => {
  const body = serializeRateHistory(
    readHistoryResult({
      points: [
        point(
          CANONICAL_TIMESTAMP,
          CANONICAL_TIMESTAMP,
          "5.20",
          "5.250000000000000000",
        ),
      ],
    }),
  );

  assert.equal(
    body.points[0]?.medianRate,
    "5.250000000000000000",
  );
});

test("JSON round-trip preserves decimal string precision", () => {
  const body = serializeRates(
    readResult({
      median: "0.1000000000000000015",
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.100000000000000001",
        ),
      ],
    }),
  );

  const serialized = JSON.stringify(body);

  assert.equal(serialized.includes("0.1000000000000000015"), true);
  assert.equal(serialized.includes("0.100000000000000001"), true);
  assert.equal(serialized.includes("bigint"), false);
});

// ---------------------------------------------------------------------------
// Null / unavailable values: handled explicitly
// ---------------------------------------------------------------------------

test("serializeRates handles null medianRate explicitly", () => {
  const body = serializeRates(readResult({ median: null }));

  assert.equal(body.medianRate, null);
});

test("serializeRates handles null ageMs explicitly", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.17",
          undefined,
          undefined,
          undefined,
          undefined,
          null,
        ),
      ],
    }),
  );

  assert.equal(body.observations[0]?.freshness.ageMs, null);
});

test("serializeRateHistory handles null medianRate explicitly", () => {
  const body = serializeRateHistory(
    readHistoryResult({
      points: [
        point(
          CANONICAL_TIMESTAMP,
          CANONICAL_TIMESTAMP,
          "5.20",
          null,
        ),
      ],
    }),
  );

  assert.equal(body.points[0]?.medianRate, null);
});

test("serializeReputation handles null score explicitly", () => {
  const record: ReputationApiAnchorRecord = Object.freeze({
    slug: "cowrie",
    name: "Cowrie",
    reputationScore: Object.freeze({
      compositeScore: null,
      scoreBand: null,
      fillRate7d: null,
      fillRate30d: null,
      fillRate90d: null,
      settleP50Ms: null,
      settleP95Ms: null,
      slippageP50: null,
      slippageP95: null,
      sampleSize: 0,
      state: "INSUFFICIENT_DATA",
      computedAt: CANONICAL_DATE,
    }),
  });

  const value = serializeReputation(record);

  assert.equal(value.score, null);
  assert.equal(value.scoreBand, null);
  assert.equal(value.metrics?.fillRate7d, null);
});

// ---------------------------------------------------------------------------
// Boundary values and floating-point avoidance
// ---------------------------------------------------------------------------

test("invalid timestamps never throw in JSON serialization", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation("zeam", "invalid", "0.17"),
      ],
    }),
  );

  assert.doesNotThrow(() => JSON.stringify(body));
  assert.equal(body.observations[0]?.capturedAt, "invalid");
});

test("decimal comparisons avoid floating-point equality assumptions", () => {
  const body = serializeRates(
    readResult({
      median: "0.1000000000000000015",
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "0.100000000000000001",
        ),
      ],
    }),
  );

  // Assert via string equality, never via Number(body.rate) === expected.
  // Decimal strings that differ textually may lose precision when coerced to Number.
  assert.equal(body.medianRate, "0.1000000000000000015");
  assert.equal(
    body.observations[0]?.rate,
    "0.100000000000000001",
  );

  assert.equal(
    (body.medianRate as string) !==
      (body.observations[0]?.rate as string),
    true,
    "textually distinct decimal strings must remain distinct as strings",
  );
});

test("decimal strings with trailing zeros preserve exact wire precision", () => {
  const body = serializeRates(
    readResult({
      observations: [
        observation(
          "zeam",
          CANONICAL_TIMESTAMP,
          "1.0000",
          "100.0000",
          "100.0000",
          "0.0000",
        ),
      ],
    }),
  );

  assert.equal(body.observations[0]?.rate, "1.0000");
  assert.equal(body.observations[0]?.sourceAmount, "100.0000");
  assert.equal(body.observations[0]?.destinationAmount, "100.0000");
  assert.equal(body.observations[0]?.fee, "0.0000");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function readResult(
  overrides: Partial<LatestCorridorRate> = {},
): LatestCorridorRate {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    evaluatedAt: CANONICAL_TIMESTAMP,
    state: "insufficient_fresh_sources",
    median: null,
    totalIndependentSources: 0,
    freshSourceCount: 0,
    observations: Object.freeze([]),
    exclusions: Object.freeze([]),
    ...overrides,
  });
}

function observation(
  anchorSlug: string,
  capturedAt: string = CANONICAL_TIMESTAMP,
  rate = "0.170000000000000001",
  sourceAmount?: string,
  destinationAmount?: string,
  fee?: string,
  freshnessState: "fresh" | "stale" | "future" | "invalid" = "fresh",
  ageMs: number | null = 1_000,
  included = true,
  exclusionReason?:
    | "stale"
    | "future_timestamp"
    | "invalid_timestamp"
    | "invalid_rate",
  anchorName = `${anchorSlug} persisted`,
) {
  return Object.freeze({
    snapshotId: `${anchorSlug}-snapshot`,
    anchorSlug,
    anchorName,
    rate,
    sourceAmount: sourceAmount ?? "100.000000000000000001",
    destinationAmount: destinationAmount ?? "17.000000000000000001",
    fee: fee ?? "1.000000000000000001",
    capturedAt,
    freshnessState,
    ageMs,
    included,
    ...(exclusionReason ? { exclusionReason } : {}),
  });
}

function readHistoryResult(
  overrides: Partial<CorridorRateHistory> = {},
): CorridorRateHistory {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: CANONICAL_TIMESTAMP,
    windowDays: 30,
    points: Object.freeze([]),
    ...overrides,
  });
}

function point(
  timestamp: string = CANONICAL_TIMESTAMP,
  capturedAt: string = CANONICAL_TIMESTAMP,
  rate = "5.20",
  medianRate: string | null = "5.25",
) {
  return Object.freeze({
    timestamp,
    medianRate,
    state: "healthy",
    sourceCount: 1,
    freshSourceCount: 1,
    observations: Object.freeze([
      Object.freeze({
        anchorSlug: "anchor-a",
        anchorName: "Anchor A",
        rate,
        sourceAmount: "100",
        destinationAmount: "520",
        fee: "0",
        capturedAt,
      }),
    ]),
  });
}
