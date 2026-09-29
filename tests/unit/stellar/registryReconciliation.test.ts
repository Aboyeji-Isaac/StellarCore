import assert from "node:assert/strict";
import test from "node:test";

import {
  planRegistryReconciliation,
  reconcileReviewedRegistry,
} from "@/lib/stellar/registryReconciliation";

const anchors = [
  { slug: "active-anchor", name: "Active", homeDomain: "active.example.com" },
  { slug: "returning-anchor", name: "Returning", homeDomain: "returning.example.com" },
] as const;
const corridors = [
  { slug: "usd-us-ngn-ng", assetCodeFrom: "USD", countryFrom: "US", assetCodeTo: "NGN", countryTo: "NG" },
] as const;
const mappings = [
  { anchorSlug: "active-anchor", corridorSlugs: ["usd-us-ngn-ng"] },
] as const;

test("plans deterministic retirement, reactivation, and association changes", () => {
  const plan = planRegistryReconciliation({
    anchors: [
      { slug: "retired-anchor", registryActive: true, signature: "Retired\u0000retired.example.com" },
      { slug: "returning-anchor", registryActive: false, signature: "Returning\u0000returning.example.com" },
      { slug: "active-anchor", registryActive: true, signature: "Active\u0000active.example.com" },
    ],
    corridors: [
      { slug: "usd-us-ngn-ng", registryActive: true, signature: "USD\u0000US\u0000NGN\u0000NG" },
      { slug: "eur-fr-usd-us", registryActive: true },
    ],
    associations: [
      { anchorSlug: "retired-anchor", corridorSlug: "eur-fr-usd-us", registryActive: true },
      { anchorSlug: "active-anchor", corridorSlug: "usd-us-ngn-ng", registryActive: false },
    ],
  }, anchors, corridors, mappings);

  assert.deepEqual(plan.anchors, {
    activated: [], updated: [], retired: ["retired-anchor"],
    reactivated: ["returning-anchor"], unchanged: ["active-anchor"],
  });
  assert.deepEqual(plan.corridors, {
    activated: [], updated: [], retired: ["eur-fr-usd-us"],
    reactivated: [], unchanged: ["usd-us-ngn-ng"],
  });
  assert.deepEqual(plan.associations, {
    activated: [], updated: [], retired: ["retired-anchor/eur-fr-usd-us"],
    reactivated: ["active-anchor/usd-us-ngn-ng"], unchanged: [],
  });
});

test("reports reviewed metadata updates separately from lifecycle changes", () => {
  const plan = planRegistryReconciliation({
    anchors: [{ slug: "active-anchor", registryActive: true, signature: "Old\u0000active.example.com" }],
    corridors: [],
    associations: [],
  }, [anchors[0]], [], []);

  assert.deepEqual(plan.anchors.updated, ["active-anchor"]);
  assert.deepEqual(plan.anchors.unchanged, []);
});

test("rejects a partial or malformed source before opening a database transaction", async () => {
  await assert.rejects(
    reconcileReviewedRegistry({
      anchors: [anchors[0]],
      corridors,
      mappings: [{ anchorSlug: "missing-anchor", corridorSlugs: [corridors[0].slug] }],
      dryRun: true,
    }),
    /Unknown anchor slug/,
  );
});
