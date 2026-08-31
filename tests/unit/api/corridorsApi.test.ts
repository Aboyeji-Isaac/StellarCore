import assert from "node:assert/strict";
import test from "node:test";

import * as route from "@/app/api/corridors/route";
import { getCorridorsApiResult, serializeCorridors } from "@/lib/api/corridors";
import type { CorridorDirectoryRecord } from "@/lib/api/corridorRepository";

test("empty persisted directory is a successful immutable response", async () => {
  const result = await getCorridorsApiResult({
    repository: { findAll: async () => [] },
  });

  assert.deepEqual(result, { status: 200, body: { corridors: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.corridors), true);
});

test("one corridor serializes its association count without internal ids", () => {
  const body = serializeCorridors([corridor("usdc-us-brl-br", 2)]);

  assert.deepEqual(body, {
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
  assert.equal("id" in body.corridors[0]!, false);
  assert.doesNotThrow(() => JSON.stringify(body));
});

test("multiple corridors are deterministically ordered by slug", () => {
  const body = serializeCorridors([
    corridor("usdc-us-usd-us", 1),
    corridor("ngnt-ng-ngn-ng", 3),
    corridor("usdc-us-brl-br", 2),
  ]);

  assert.deepEqual(body.corridors.map(({ slug }) => slug), [
    "ngnt-ng-ngn-ng",
    "usdc-us-brl-br",
    "usdc-us-usd-us",
  ]);
  assert.deepEqual(body.corridors.map(({ anchorCount }) => anchorCount), [3, 2, 1]);
});

test("repository failures return the stable safe error envelope", async () => {
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

test("route exports GET only and explicitly disables caching", async () => {
  assert.equal(route.dynamic, "force-dynamic");
  assert.equal("POST" in route, false);
  assert.equal("PUT" in route, false);
  assert.equal("DELETE" in route, false);
});

function corridor(slug: string, anchorCount: number): CorridorDirectoryRecord {
  const [sourceAsset, sourceCountry, destinationAsset, destinationCountry] =
    slug.split("-");
  return Object.freeze({
    slug,
    assetCodeFrom: sourceAsset!.toUpperCase(),
    countryFrom: sourceCountry!.toUpperCase(),
    assetCodeTo: destinationAsset!.toUpperCase(),
    countryTo: destinationCountry!.toUpperCase(),
    anchorCount,
  });
}

