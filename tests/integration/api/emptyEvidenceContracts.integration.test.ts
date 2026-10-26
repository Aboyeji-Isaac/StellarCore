import assert from "node:assert/strict";
import test from "node:test";

import { getAnchorsApiResult } from "@/lib/api/anchors";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import { getRatesApiResult } from "@/lib/api/rates";
import { getReputationApiResult } from "@/lib/api/reputation";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";
const NO_STALE_STORE: StaleEvidenceStore = {
  read: async () => null,
  write: async () => {},
};

test("four public read views preserve successful empty persisted-evidence contracts", async () => {
  const anchors = await getAnchorsApiResult({
    repository: { findAll: async () => [], findBySlug: async () => null },
  });
  const corridors = await getCorridorsApiResult({
    repository: { findAll: async () => [] },
  });
  const rates = await getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    readLatestRate: async (slug) => ({
      ok: true,
      corridor: { slug, assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR" },
      evaluatedAt: NOW.toISOString(),
      state: "insufficient_fresh_sources",
      median: null,
      totalIndependentSources: 0,
      freshSourceCount: 0,
      observations: [],
      exclusions: [],
    }),
  });
  const reputation = await getReputationApiResult({
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    repository: { findAll: async () => [], findBySlug: async () => null },
  });

  assert.deepEqual(anchors, { status: 200, body: { anchors: [], count: 0 } });
  assert.deepEqual(corridors, { status: 200, body: { corridors: [], count: 0 } });
  assert.equal(rates.status, 200);
  if (rates.status === 200) {
    assert.deepEqual(rates.body, {
      corridor: { slug: CORRIDOR, sourceAsset: "USDC", sourceCountry: "US", destinationAsset: "BRL", destinationCountry: "BR" },
      evaluatedAt: NOW.toISOString(),
      state: "insufficient_fresh_sources",
      medianRate: null,
      sourceCount: 0,
      freshSourceCount: 0,
      reviewedCandidateConfiguration: { candidateCount: 1, uniqueAnchorCount: 1 },
      medianRequirement: { minimumFreshIndependentSources: 2 },
      observations: [],
    });
  }
  assert.deepEqual(reputation, { status: 200, body: { reputation: [], count: 0 } });
});

test("an empty store and a failed read remain distinguishable on every view", async () => {
  const reporter = () => {};
  const failed = await Promise.all([
    getAnchorsApiResult({ repository: { findAll: async () => { throw Error("private db detail"); }, findBySlug: async () => null }, reportError: reporter }),
    getCorridorsApiResult({ repository: { findAll: async () => { throw Error("private db detail"); } }, reportError: reporter }),
    getRatesApiResult(CORRIDOR, { now: () => NOW, staleEvidenceStore: NO_STALE_STORE, readLatestRate: async () => { throw Error("private db detail"); }, reportError: reporter }),
    getReputationApiResult({ now: () => NOW, staleEvidenceStore: NO_STALE_STORE, repository: { findAll: async () => { throw Error("private db detail"); }, findBySlug: async () => null }, reportError: reporter }),
  ]);

  for (const result of failed) {
    assert.equal(result.status, 500);
    assert.equal(result.body.error.code, "internal_error");
    assert.equal(JSON.stringify(result).includes("private db detail"), false);
  }
});
