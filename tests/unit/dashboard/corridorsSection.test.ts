import assert from "node:assert/strict";
import test from "node:test";

import { getCorridorsApiResult } from "@/lib/api/corridors";

test("empty persisted directory returns successful immutable response", async () => {
  const result = await getCorridorsApiResult({
    repository: { findAll: async () => [] },
  });

  assert.deepEqual(result, { status: 200, body: { corridors: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.corridors), true);
});

test("corridor serialization maps internal fields to public API format", async () => {
  const result = await getCorridorsApiResult({
    repository: { findAll: async () => [
      { slug: "usdc-us-brl-br", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR", anchorCount: 2 },
    ] },
  });

  assert.deepEqual(result.body, {
    corridors: [{
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
      anchorCount: 2,
    }],
    count: 1,
  });
  assert.equal("id" in result.body.corridors[0]!, false);
});

test("corridors are deterministically ordered by slug", async () => {
  const result = await getCorridorsApiResult({
    repository: { findAll: async () => [
      { slug: "usdc-us-usd-us", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "USD", countryTo: "US", anchorCount: 1 },
      { slug: "ngnt-ng-ngn-ng", assetCodeFrom: "NGNT", countryFrom: "NG", assetCodeTo: "NGN", countryTo: "NG", anchorCount: 3 },
      { slug: "usdc-us-brl-br", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR", anchorCount: 2 },
    ] },
  });

  assert.deepEqual(result.body.corridors.map(({ slug }) => slug), [
    "ngnt-ng-ngn-ng",
    "usdc-us-brl-br",
    "usdc-us-usd-us",
  ]);
  assert.deepEqual(result.body.corridors.map(({ anchorCount }) => anchorCount), [3, 2, 1]);
});

test("repository failures return stable safe error envelope", async () => {
  const result = await getCorridorsApiResult({
    repository: {
      findAll: async () => {
        throw new Error("DATABASE_URL=secret SQL failure");
      },
    },
  });

  assert.deepEqual(result, {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unable to load corridors." },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("malformed pagination returns 400 before repository access", async () => {
  for (const query of [
    { limit: "0", offset: null },
    { limit: "abc", offset: null },
    { limit: "101", offset: null },
    { limit: null, offset: "-1" },
  ] as const) {
    const repoWithSpy = Object.freeze({ findAll: async () => [] });
    const result = await getCorridorsApiResult({ repository: repoWithSpy }, query);

    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid_pagination");
  }
});
