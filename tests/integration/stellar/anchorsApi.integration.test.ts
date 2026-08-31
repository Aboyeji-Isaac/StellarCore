import assert from "node:assert/strict";
import test from "node:test";

import { getAnchorApiResult, getAnchorsApiResult } from "@/lib/api/anchors";
import type { AnchorDirectoryRepository } from "@/lib/api/anchorRepository";

test("persisted anchor records and junctions compose without registry or history reads", async () => {
  const calls: string[] = [];
  const repository: AnchorDirectoryRepository = {
    findAll: async () => {
      calls.push("findAll");
      return [{
        slug: "persisted-anchor",
        name: "Persisted Anchor",
        homeDomain: "persisted.example",
        status: "DOWN",
        seps: [38, 1],
        corridorCount: 1,
      }];
    },
    findBySlug: async (slug) => {
      calls.push(`findBySlug:${slug}`);
      return slug === "persisted-anchor" ? {
        slug,
        name: "Persisted Anchor",
        homeDomain: "persisted.example",
        status: "DOWN",
        seps: [38, 1],
        corridors: [{
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        }],
      } : null;
    },
  };

  const list = await getAnchorsApiResult({ repository });
  const detail = await getAnchorApiResult("persisted-anchor", { repository });
  const registryOnly = await getAnchorApiResult("registry-only", { repository });

  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(registryOnly.status, 404);
  if (list.status !== 200 || detail.status !== 200) return;
  assert.equal(list.body.anchors[0]?.corridorCount, 1);
  assert.equal(detail.body.anchor.corridors[0]?.slug, "usdc-us-brl-br");
  assert.deepEqual(calls, [
    "findAll",
    "findBySlug:persisted-anchor",
    "findBySlug:registry-only",
  ]);
  const serialized = JSON.stringify({ list, detail });
  assert.equal(serialized.includes("rateSnapshot"), false);
  assert.equal(serialized.includes("anchorId"), false);
});
