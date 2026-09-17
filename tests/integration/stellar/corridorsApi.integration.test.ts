import assert from "node:assert/strict";
import test from "node:test";

import { getCorridorApiResult, getCorridorsApiResult } from "@/lib/api/corridors";
import type {
  CorridorDetailRepository,
  CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";

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

test("persisted corridor relationships drive detail without static registry or history reads", async () => {
  const calls: string[] = [];
  const repository: CorridorDetailRepository = {
    findBySlug: async (slug) => {
      calls.push(`findBySlug:${slug}`);
      return slug === "persisted-corridor" ? {
        slug,
        assetCodeFrom: "ASSET",
        countryFrom: "AA",
        assetCodeTo: "FIAT",
        countryTo: "BB",
        anchors: [{
          slug: "persisted-anchor",
          name: "Persisted Anchor",
          homeDomain: "persisted.example",
          status: "DOWN",
          seps: [38, 1],
        }],
      } : null;
    },
  };

  const result = await getCorridorApiResult("persisted-corridor", { repository });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.corridor.slug, "persisted-corridor");
  assert.deepEqual(result.body.corridor.anchors, [{
    slug: "persisted-anchor",
    name: "Persisted Anchor",
    homeDomain: "persisted.example",
    status: "DOWN",
    seps: [1, 38],
    isTransferCapable: false,
  }]);
  assert.deepEqual(calls, ["findBySlug:persisted-corridor"]);

  const serialized = JSON.stringify(result.body);
  for (const forbidden of [
    "anchorId",
    "corridorId",
    "rateSnapshot",
    "reputationScore",
    "transferOutcome",
    "tomlUrl",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});
