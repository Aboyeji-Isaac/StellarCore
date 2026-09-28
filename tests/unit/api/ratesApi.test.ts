import assert from "node:assert/strict";
import test from "node:test";

import { GET, dynamic } from "@/app/api/rates/route";
import { MIN_FRESH_SOURCES } from "@/constants/rates";
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
        totalObservationCount: 1,
        freshObservationCount: 1,
        independentAuthorityCount: 1,
        freshIndependentSourceCount: 1,
        observations: [observation(
          "zeam",
          "0.170000000000000001",
          "fresh",
          1_000,
          true,
          undefined,
          "Persisted Zeam Name",
        )],
      });
    },
  });

  assert.equal(usedEvaluationTime, NOW);
  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.equal(result.body.observations[0]?.anchor.name, "Persisted Zeam Name");
  assert.equal(result.body.observations[0]?.rate, "0.170000000000000001");
  assert.equal(typeof result.body.observations[0]?.rate, "string");
  assert.equal(result.body.observations[0]?.authority.id, "auth-0001");
  assert.equal(result.body.observations[0]?.authority.displayName, "Zeam");
  assert.equal(result.body.observations[0]?.authority.configurationVersion, 1);
  assert.equal(result.body.evaluatedAt, NOW.toISOString());
  assert.deepEqual(result.body.reviewedCandidateConfiguration, {
    candidateCount: 1,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
  assert.deepEqual(result.body.medianRequirement, {
    minimumFreshIndependentSources: MIN_FRESH_SOURCES,
  });
});

test("persisted corridor and anchor identity do not require static registry entries", async () => {
  const corridorSlug = "persisted-asset-aa-fiat-bb";
  const result = await getRatesApiResult(corridorSlug, {
    now: () => NOW,
    readLatestRate: async () => readResult({
      corridor: Object.freeze({
        slug: corridorSlug,
        assetCodeFrom: "PERSISTED",
        countryFrom: "AA",
        assetCodeTo: "FIAT",
        countryTo: "BB",
      }),
      totalObservationCount: 1,
      freshObservationCount: 1,
      independentAuthorityCount: 1,
      freshIndependentSourceCount: 1,
      observations: [observation(
        "persisted-anchor",
        "1.250000000000000001",
        "fresh",
        1_000,
        true,
        undefined,
        "Persisted Anchor Name",
      )],
    }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.corridor, {
    slug: corridorSlug,
    sourceAsset: "PERSISTED",
    sourceCountry: "AA",
    destinationAsset: "FIAT",
    destinationCountry: "BB",
  });
  assert.deepEqual(result.body.observations[0]?.anchor, {
    slug: "persisted-anchor",
    name: "Persisted Anchor Name",
  });
  assert.deepEqual(result.body.reviewedCandidateConfiguration, {
    candidateCount: 0,
    uniqueAnchorCount: 0,
    uniqueAuthorityCount: 0,
  });
  assert.equal(result.body.sourceCount, 1);
  assert.equal(result.body.freshSourceCount, 1);
  assert.equal(result.body.medianRate, null);
});

test("configured candidates without observations do not become persisted evidence", async () => {
  const result = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    readLatestRate: async () => readResult({ observations: Object.freeze([]) }),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.reviewedCandidateConfiguration, {
    candidateCount: 1,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
  assert.equal(result.body.sourceCount, 0);
  assert.equal(result.body.freshSourceCount, 0);
  assert.equal(result.body.totalObservationCount, 0);
  assert.equal(result.body.freshObservationCount, 0);
  assert.equal(result.body.independentAuthorityCount, 0);
  assert.deepEqual(result.body.observations, []);
  assert.deepEqual(result.body.corridor, {
    slug: CORRIDOR,
    sourceAsset: "USDC",
    sourceCountry: "US",
    destinationAsset: "BRL",
    destinationCountry: "BR",
  });
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
});

test("serializer exposes an exact healthy median and normalized exclusions", () => {
  const body = serializeRates(readResult({
    state: "healthy",
    median: "0.1000000000000000015",
    totalObservationCount: 4,
    freshObservationCount: 3,
    independentAuthorityCount: 2,
    freshIndependentSourceCount: 2,
    observations: [
      observation("zeam", "0.100000000000000001", "fresh", 1, true),
      observation(
        "anchor-b",
        "0.100000000000000002",
        "fresh",
        2,
        true,
        undefined,
        "Anchor B Persisted",
        "auth-0002",
        null,
      ),
      observation(
        "anchor-c",
        "9",
        "fresh",
        3,
        false,
        "correlated_same_authority",
        "Anchor C Persisted",
        "auth-0001",
      ),
      observation("anchor-d", "8", "stale", 120_001, false, "stale", "Anchor D Persisted", null, null),
    ],
  }));

  assert.equal(body.medianRate, "0.1000000000000000015");
  assert.equal(body.observations[3]?.freshness.state, "stale");
  assert.equal(body.observations[2]?.exclusionReason, "correlated_same_authority");
  assert.equal(body.observations[2]?.authority.id, "auth-0001");
  assert.equal(body.observations[2]?.authority.displayName, "Zeam");
  assert.equal(body.observations[1]?.authority.id, "auth-0002");
  assert.equal(body.observations[1]?.authority.displayName, null);
  assert.equal(body.observations[3]?.authority.id, null);
  assert.equal(body.observations[3]?.authority.displayName, null);
  assert.equal(body.observations[3]?.authority.configurationVersion, null);
  assert.equal(body.sourceCount, 4);
  assert.equal(body.freshSourceCount, 2);
  assert.equal(body.totalObservationCount, 4);
  assert.equal(body.freshObservationCount, 3);
  assert.equal(body.independentAuthorityCount, 2);
  assert.deepEqual(body.reviewedCandidateConfiguration, {
    candidateCount: 1,
    uniqueAnchorCount: 1,
    uniqueAuthorityCount: 1,
  });
  assert.deepEqual(body.medianRequirement, {
    minimumFreshIndependentSources: MIN_FRESH_SOURCES,
  });
  assert.deepEqual(Object.keys(body.reviewedCandidateConfiguration).sort(), [
    "candidateCount",
    "uniqueAnchorCount",
    "uniqueAuthorityCount",
  ]);
  assert.equal(JSON.stringify(body).includes("sellAsset"), false);
  assert.equal("snapshotId" in body.observations[0]!, false);
  assert.equal("authorityConfigurationVersion" in body.observations[0]!, false);
  assert.equal(Object.isFrozen(body), true);
  assert.equal(Object.isFrozen(body.observations), true);
  assert.equal(Object.isFrozen(body.observations[0]), true);
  assert.equal(Object.isFrozen(body.observations[0]?.authority), true);
  assert.equal(Object.isFrozen(body.reviewedCandidateConfiguration), true);
  assert.equal(Object.isFrozen(body.medianRequirement), true);
  assert.deepEqual(Object.keys(body).sort(), [
    "corridor",
    "evaluatedAt",
    "freshObservationCount",
    "freshSourceCount",
    "independentAuthorityCount",
    "medianRate",
    "medianRequirement",
    "observations",
    "reviewedCandidateConfiguration",
    "sourceCount",
    "state",
    "totalObservationCount",
  ]);
  assert.deepEqual(Object.keys(body.corridor).sort(), [
    "destinationAsset",
    "destinationCountry",
    "slug",
    "sourceAsset",
    "sourceCountry",
  ]);
  assert.deepEqual(Object.keys(body.observations[0]!).sort(), [
    "anchor",
    "authority",
    "capturedAt",
    "destinationAmount",
    "eligibleForMedian",
    "fee",
    "freshness",
    "rate",
    "sourceAmount",
  ]);
  assert.doesNotThrow(() => JSON.stringify(body));
  assert.equal(JSON.stringify(body).includes("bigint"), false);
});

function readResult(
  overrides: Partial<LatestCorridorRate>,
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
    evaluatedAt: NOW.toISOString(),
    state: "insufficient_fresh_sources",
    median: null,
    totalObservationCount: 0,
    freshObservationCount: 0,
    independentAuthorityCount: 0,
    freshIndependentSourceCount: 0,
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
  exclusionReason?:
    | "stale"
    | "future_timestamp"
    | "invalid_timestamp"
    | "invalid_rate"
    | "unknown_authority"
    | "correlated_same_authority",
  anchorName = `${anchorSlug} persisted`,
  authorityId: string | null = "auth-0001",
  authorityConfigurationVersion: number | null = authorityId === null ? null : 1,
) {
  return Object.freeze({
    snapshotId: `${anchorSlug}-snapshot`,
    anchorSlug,
    anchorName,
    authorityId,
    authorityConfigurationVersion,
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
