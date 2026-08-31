import assert from "node:assert/strict";
import test from "node:test";

import { getCorridorsApiResult } from "@/lib/api/corridors";
import type { CorridorDirectoryRepository } from "@/lib/api/corridorRepository";

test("persisted corridor rows and junction counts compose without rate history", async () => {
  const repository: CorridorDirectoryRepository = {
    findAll: async () => [
      {
        slug: "usdc-us-usd-us",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "USD",
        countryTo: "US",
        anchorCount: 1,
      },
      {
        slug: "ngnt-ng-ngn-ng",
        assetCodeFrom: "NGNT",
        countryFrom: "NG",
        assetCodeTo: "NGN",
        countryTo: "NG",
        anchorCount: 2,
      },
    ],
  };

  const result = await getCorridorsApiResult({ repository });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.count, 2);
  assert.deepEqual(result.body.corridors.map(({ slug, anchorCount }) => ({
    slug,
    anchorCount,
  })), [
    { slug: "ngnt-ng-ngn-ng", anchorCount: 2 },
    { slug: "usdc-us-usd-us", anchorCount: 1 },
  ]);
  assert.equal(JSON.stringify(result.body).includes("rateSnapshot"), false);
});

