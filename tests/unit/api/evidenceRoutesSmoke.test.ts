import assert from "node:assert/strict";
import test from "node:test";

import { getRatesApiResult } from "@/lib/api/rates";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import {
  getReputationApiResult,
  getAnchorReputationApiResult,
} from "@/lib/api/reputation";
import type { LatestCorridorRate } from "@/types/latestRates";
import type { CorridorRateHistory } from "@/types/rateHistory";
import type { ReputationApiAnchorRecord, ReputationApiRepository } from "@/lib/api/reputationRepository";

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-08-28T12:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readResult(overrides: Partial<LatestCorridorRate> = {}): LatestCorridorRate {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    evaluatedAt: NOW.toISOString(),
    state: "insufficient_fresh_sources",
    median: null,
    totalIndependentSources: 0,
    freshSourceCount: 0,
    observations: Object.freeze([]),
    exclusions: Object.freeze([]),
    ...overrides,
  });
}

function historyResult(overrides: Partial<CorridorRateHistory> = {}): CorridorRateHistory {
  return Object.freeze({
    ok: true,
    corridor: Object.freeze({
      slug: CORRIDOR,
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }),
    evaluatedAt: NOW.toISOString(),
    windowDays: 30,
    points: Object.freeze([]),
    ...overrides,
  });
}

function reputationRecord(
  slug: string,
  reputationScore: ReputationApiAnchorRecord["reputationScore"] = null,
): ReputationApiAnchorRecord {
  return Object.freeze({
    slug,
    name: `${slug[0]!.toUpperCase()}${slug.slice(1)}`,
    reputationScore,
  });
}

function reputationRepository(
  records: readonly ReputationApiAnchorRecord[],
  record: ReputationApiAnchorRecord | null = null,
  listError?: Error,
  detailError?: Error,
): ReputationApiRepository {
  return Object.freeze({
    findAll: async () => {
      if (listError) throw listError;
      return records;
    },
    findBySlug: async () => {
      if (detailError) throw detailError;
      return record;
    },
  });
}

// ---------------------------------------------------------------------------
// Route 1: GET /api/rates
// ---------------------------------------------------------------------------

test("rates route: valid corridor returns 200 with expected response envelope", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => readResult(),
  });
  assert.equal(result.status, 200, "rates route: expected 200 for valid corridor");
  if (result.status !== 200) return;
  assert.equal("body" in result, true, "rates route: response must include body");
  assert.equal(result.body.state, "insufficient_fresh_sources", "rates route: expected insufficient state");
  assert.equal(result.body.medianRate, null, "rates route: expected null median when empty");
  assert.equal(Array.isArray(result.body.observations), true, "rates route: observations must be an array");
});

test("rates route: missing corridor returns 400", async () => {
  const result = await getRatesApiResult(null, { now: () => NOW });
  assert.equal(result.status, 400, "rates route: expected 400 for missing corridor");
  if (result.status !== 400) return;
  assert.equal(result.body.error.code, "missing_corridor", "rates route: expected missing_corridor error code");
});

test("rates route: invalid corridor returns 400", async () => {
  const result = await getRatesApiResult("bad--slug", { now: () => NOW });
  assert.equal(result.status, 400, "rates route: expected 400 for invalid corridor");
  if (result.status !== 400) return;
  assert.equal(result.body.error.code, "invalid_corridor", "rates route: expected invalid_corridor error code");
});

test("rates route: unknown corridor returns 404", async () => {
  const result = await getRatesApiResult("unknown-corridor", {
    now: () => NOW,
    readLatestRate: async (slug) => ({
      ok: false,
      corridorSlug: slug,
      code: "CORRIDOR_NOT_FOUND",
    }),
  });
  assert.equal(result.status, 404, "rates route: expected 404 for unknown corridor");
  if (result.status !== 404) return;
  assert.equal(result.body.error.code, "corridor_not_found", "rates route: expected corridor_not_found error code");
});

test("rates route: database failure returns 500 without leaking secrets", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => {
      throw new Error("DATABASE_URL=secret stack trace");
    },
  });
  assert.equal(result.status, 500, "rates route: expected 500 for database failure");
  if (result.status !== 500) return;
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret"), false, "rates route: 500 body must not leak secrets");
  assert.equal(result.body.error.code, "internal_error", "rates route: expected internal_error code");
});

// ---------------------------------------------------------------------------
// Route 2: GET /api/rates/history
// ---------------------------------------------------------------------------

test("rate history route: valid corridor and days returns 200 with expected envelope", async () => {
  const result = await getRateHistoryApiResult(CORRIDOR, "30", {
    now: () => NOW,
    readHistory: async () => historyResult(),
  });
  assert.equal(result.status, 200, "rate history route: expected 200 for valid request");
  if (result.status !== 200) return;
  assert.equal("body" in result, true, "rate history route: response must include body");
  assert.equal(result.body.windowDays, 30, "rate history route: expected 30 day window");
  assert.equal(Array.isArray(result.body.points), true, "rate history route: points must be an array");
});

test("rate history route: missing corridor returns 400", async () => {
  const result = await getRateHistoryApiResult(null, "30", { now: () => NOW });
  assert.equal(result.status, 400, "rate history route: expected 400 for missing corridor");
  if (result.status !== 400) return;
  assert.equal(result.body.error.code, "missing_corridor", "rate history route: expected missing_corridor error code");
});

test("rate history route: invalid days returns 400", async () => {
  for (const invalidDays of ["abc", "-1", "0", "366", "1.5"]) {
    const result = await getRateHistoryApiResult(CORRIDOR, invalidDays, { now: () => NOW });
    assert.equal(result.status, 400, `rate history route: expected 400 for days=${invalidDays}`);
    if (result.status !== 400) return;
    assert.equal(result.body.error.code, "invalid_days", "rate history route: expected invalid_days error code");
  }
});

test("rate history route: unknown corridor returns 404", async () => {
  const result = await getRateHistoryApiResult("unknown-corridor", "30", {
    now: () => NOW,
    readHistory: async (slug) => ({
      ok: false,
      corridorSlug: slug,
      code: "CORRIDOR_NOT_FOUND",
    }),
  });
  assert.equal(result.status, 404, "rate history route: expected 404 for unknown corridor");
  if (result.status !== 404) return;
  assert.equal(result.body.error.code, "corridor_not_found", "rate history route: expected corridor_not_found error code");
});

test("rate history route: database failure returns 500 without leaking secrets", async () => {
  const result = await getRateHistoryApiResult(CORRIDOR, "30", {
    now: () => NOW,
    readHistory: async () => {
      throw new Error("DATABASE_URL=secret stack trace");
    },
  });
  assert.equal(result.status, 500, "rate history route: expected 500 for database failure");
  if (result.status !== 500) return;
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret"), false, "rate history route: 500 body must not leak secrets");
  assert.equal(result.body.error.code, "internal_error", "rate history route: expected internal_error code");
});

// ---------------------------------------------------------------------------
// Route 3: GET /api/reputation
// ---------------------------------------------------------------------------

test("reputation list route: records return 200 with expected envelope", async () => {
  const records = [reputationRecord("zeam"), reputationRecord("cowrie")];
  const result = await getReputationApiResult({ repository: reputationRepository(records) });
  assert.equal(result.status, 200, "reputation list route: expected 200 with records");
  if (result.status !== 200) return;
  assert.equal("body" in result, true, "reputation list route: response must include body");
  assert.equal(result.body.count, 2, "reputation list route: expected count of 2");
  assert.equal(Array.isArray(result.body.reputation), true, "reputation list route: reputation must be an array");
});

test("reputation list route: empty records returns 200 with empty array (not error)", async () => {
  const result = await getReputationApiResult({ repository: reputationRepository([]) });
  assert.equal(result.status, 200, "reputation list route: expected 200 for empty records");
  if (result.status !== 200) return;
  assert.equal(result.body.count, 0, "reputation list route: expected count of 0 for empty");
  assert.deepEqual(result.body.reputation, [], "reputation list route: expected empty reputation array");
});

test("reputation list route: database failure returns 500 without leaking secrets", async () => {
  const result = await getReputationApiResult({
    repository: reputationRepository([], null, new Error("Prisma secret")),
  });
  assert.equal(result.status, 500, "reputation list route: expected 500 for database failure");
  if (result.status !== 500) return;
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret"), false, "reputation list route: 500 body must not leak secrets");
  assert.equal(result.body.error.code, "internal_error", "reputation list route: expected internal_error code");
});

// ---------------------------------------------------------------------------
// Route 4: GET /api/reputation/[slug]
// ---------------------------------------------------------------------------

test("reputation detail route: known anchor returns 200 with expected envelope", async () => {
  const record = reputationRecord("zeam", {
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
    computedAt: NOW,
  });
  const result = await getAnchorReputationApiResult("zeam", {
    repository: reputationRepository([], record),
  });
  assert.equal(result.status, 200, "reputation detail route: expected 200 for known anchor");
  if (result.status !== 200) return;
  assert.equal("body" in result, true, "reputation detail route: response must include body");
  assert.equal(result.body.reputation.anchor.slug, "zeam", "reputation detail route: expected zeam anchor slug");
  assert.equal(result.body.reputation.state, "established", "reputation detail route: expected established state");
});

test("reputation detail route: unknown anchor returns 404", async () => {
  const result = await getAnchorReputationApiResult("unknown-anchor", {
    repository: reputationRepository([], null),
  });
  assert.equal(result.status, 404, "reputation detail route: expected 404 for unknown anchor");
  if (result.status !== 404) return;
  assert.equal(result.body.error.code, "anchor_not_found", "reputation detail route: expected anchor_not_found error code");
});

test("reputation detail route: invalid slug returns 400", async () => {
  for (const invalidSlug of ["", "../cowrie", " Cowrie ", "bad--slug", "a".repeat(101)]) {
    const result = await getAnchorReputationApiResult(invalidSlug, {
      repository: reputationRepository([]),
    });
    assert.equal(result.status, 400, `reputation detail route: expected 400 for slug=${JSON.stringify(invalidSlug)}`);
    if (result.status !== 400) return;
    assert.equal(result.body.error.code, "invalid_anchor_slug", "reputation detail route: expected invalid_anchor_slug error code");
  }
});

test("reputation detail route: database failure returns 500 without leaking secrets", async () => {
  const result = await getAnchorReputationApiResult("zeam", {
    repository: reputationRepository([], null, undefined, new Error("Prisma secret")),
  });
  assert.equal(result.status, 500, "reputation detail route: expected 500 for database failure");
  if (result.status !== 500) return;
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret"), false, "reputation detail route: 500 body must not leak secrets");
  assert.equal(result.body.error.code, "internal_error", "reputation detail route: expected internal_error code");
});
