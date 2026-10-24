import assert from "node:assert/strict";
import test from "node:test";

import { getRatesApiResult } from "@/lib/api/rates";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";

type RateReadResultOverride = Partial<{
  ok: boolean;
  corridor: Readonly<{
    slug: string;
    assetCodeFrom: string;
    countryFrom: string;
    assetCodeTo: string;
    countryTo: string;
  }>;
  evaluatedAt: string;
  state: string;
  median: string | null;
  totalIndependentSources: number;
  freshSourceCount: number;
  observations: readonly unknown[];
  exclusions: readonly unknown[];
}>;

function readResult(overrides: RateReadResultOverride = {}) {
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

function observation(
  anchorSlug: string,
  rate: string,
  freshnessState: "fresh" | "stale" | "future" | "invalid",
  ageMs: number | null,
  included: boolean,
  exclusionReason?: "stale" | "future_timestamp",
) {
  return Object.freeze({
    snapshotId: `${anchorSlug}-snapshot`,
    anchorSlug,
    anchorName: anchorSlug[0]!.toUpperCase() + anchorSlug.slice(1),
    rate,
    sourceAmount: "100.000000000000000001",
    destinationAmount: "17.000000000000000001",
    fee: "1.000000000000000001",
    capturedAt: freshnessState === "invalid" ? "invalid" : NOW.toISOString(),
    freshnessState,
    ageMs,
    included,
    ...(exclusionReason ? { exclusionReason } : {}),
  });
}

test("empty corridor returns insufficient fresh sources", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => readResult({ observations: Object.freeze([]) }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.deepEqual(result.body.observations, []);
  assert.equal(result.body.sourceCount, 0);
  assert.equal(result.body.freshSourceCount, 0);
});

test("single fresh source returns insufficient state", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => readResult({
      totalIndependentSources: 1,
      freshSourceCount: 1,
      observations: [observation("zeam", "0.170000000000000001", "fresh", 1_000, true)],
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.equal(result.body.sourceCount, 1);
  assert.equal(result.body.freshSourceCount, 1);
  assert.equal(result.body.observations[0]?.anchor.slug, "zeam");
  assert.equal(result.body.observations[0]?.rate, "0.170000000000000001");
});

test("healthy median with multiple sources", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => readResult({
      state: "healthy",
      median: "0.1000000000000000015",
      totalIndependentSources: 4,
      freshSourceCount: 2,
      observations: [
        observation("zeam", "0.100000000000000001", "fresh", 1, true),
        observation("anchor-b", "0.100000000000000002", "fresh", 2, true),
        observation("anchor-c", "9", "stale", 120_001, false, "stale"),
        observation("anchor-d", "8", "future", -1, false, "future_timestamp"),
      ],
    }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.state, "healthy");
  assert.equal(result.body.medianRate, "0.1000000000000000015");
  assert.equal(result.body.sourceCount, 4);
  assert.equal(result.body.freshSourceCount, 2);
  assert.equal(result.body.observations[2]?.freshness.state, "stale");
  assert.equal(result.body.observations[3]?.exclusionReason, "future_timestamp");
});

test("repository failures return stable safe error envelope", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => {
      throw new Error("DATABASE_URL=secret SQL failure");
    },
  });

  assert.deepEqual(result, {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unable to read rates." },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("corridor not found returns 404", async () => {
  const result = await getRatesApiResult("unknown-corridor", {
    now: () => NOW,
    readLatestRate: async () => ({
      ok: false,
      corridorSlug: "unknown-corridor",
      code: "CORRIDOR_NOT_FOUND",
    }),
  });

  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, "corridor_not_found");
});
