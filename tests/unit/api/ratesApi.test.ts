import assert from "node:assert/strict";
import test from "node:test";

import { GET, dynamic } from "@/app/api/rates/route";
import { getRatesApiResult, serializeRates } from "@/lib/api/rates";
import type { LatestCorridorRate } from "@/types/latestRates";

const CORRIDOR = "usdc-us-brl-br";
const NOW = new Date("2026-08-28T12:00:00.000Z");

test("route rejects missing and malformed corridor parameters safely", async () => {
  const missing = await GET(new Request("http://localhost/api/rates"));
  assert.equal(missing.status, 400);
  assert.deepEqual(await missing.json(), {
    error: {
      code: "missing_corridor",
      message: "A corridor slug is required.",
    },
  });

  for (const value of ["../rates", " USDC ", "a".repeat(101)]) {
    const response = await GET(new Request(
      `http://localhost/api/rates?corridor=${encodeURIComponent(value)}`,
    ));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_corridor");
  }
});

test("route is request-dynamic and explicitly prevents freshness caching", async () => {
  assert.equal(dynamic, "force-dynamic");
  const response = await GET(new Request("http://localhost/api/rates?corridor=bad--slug"));
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("service maps unknown corridors and read failures to safe errors", async () => {
  const missing = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async (slug) => ({
      ok: false,
      corridorSlug: slug,
      code: "CORRIDOR_NOT_FOUND",
    }),
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "corridor_not_found");

  const failed = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => {
      throw new Error("DATABASE_URL=secret stack trace");
    },
  });
  assert.deepEqual(failed, {
    status: 500,
    body: { error: { code: "internal_error", message: "Unable to read rates." } },
  });
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("one source is a successful insufficient response with string decimals", async () => {
  let usedEvaluationTime: Date | undefined;
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async (_slug, { evaluatedAt }) => {
      usedEvaluationTime = evaluatedAt;
      return readResult({
        state: "insufficient_fresh_sources",
        median: null,
        totalIndependentSources: 1,
        freshSourceCount: 1,
        observations: [observation("zeam", "0.170000000000000001", "fresh", 1_000, true)],
      });
    },
  });

  assert.equal(usedEvaluationTime, NOW);
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.equal(result.body.observations[0]?.anchor.name, "Zeam");
  assert.equal(result.body.observations[0]?.rate, "0.170000000000000001");
  assert.equal(typeof result.body.observations[0]?.rate, "string");
  assert.equal(result.body.evaluatedAt, NOW.toISOString());
});

test("serializer exposes an exact healthy median and normalized exclusions", () => {
  const body = serializeRates(readResult({
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
  }));

  assert.equal(body.medianRate, "0.1000000000000000015");
  assert.equal(body.observations[2]?.freshness.state, "stale");
  assert.equal(body.observations[3]?.exclusionReason, "future_timestamp");
  assert.equal("snapshotId" in body.observations[0]!, false);
  assert.equal(Object.isFrozen(body), true);
  assert.equal(Object.isFrozen(body.observations), true);
  assert.equal(Object.isFrozen(body.observations[0]), true);
  assert.doesNotThrow(() => JSON.stringify(body));
  assert.equal(JSON.stringify(body).includes("bigint"), false);
});

function readResult(
  overrides: Partial<LatestCorridorRate>,
): LatestCorridorRate {
  return Object.freeze({
    ok: true,
    corridorSlug: CORRIDOR,
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
  exclusionReason?: "stale" | "future_timestamp" | "invalid_timestamp" | "invalid_rate",
) {
  return Object.freeze({
    snapshotId: `${anchorSlug}-snapshot`,
    anchorSlug,
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
