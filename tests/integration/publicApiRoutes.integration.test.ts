import assert from "node:assert/strict";
import test from "node:test";

import {
  getAnchorApiResult,
  getAnchorsApiResult,
} from "@/lib/api/anchors";
import {
  getCorridorApiResult,
  getCorridorsApiResult,
} from "@/lib/api/corridors";
import { getRatesApiResult } from "@/lib/api/rates";
import {
  getAnchorReputationApiResult,
  getReputationApiResult,
} from "@/lib/api/reputation";
import type { LatestRateRepository } from "@/types/latestRates";

const EVALUATED_AT = new Date("2026-09-23T12:00:00.000Z");

test("all public directory and detail routes return JSON-safe current contracts", async () => {
  const anchorRepository = {
    findAll: async () => [anchorRecord("unevaluated")],
    findBySlug: async (slug: string) =>
      slug === "unevaluated" ? anchorRecord(slug) : null,
  };
  const corridorRepository = {
    findAll: async () => [corridorRecord()],
    findBySlug: async (slug: string) =>
      slug === "usdc-us-brl-br" ? corridorDetailRecord() : null,
  };
  const reputationRepository = {
    findAll: async () => [reputationRecord()],
    findBySlug: async (slug: string) =>
      slug === "unevaluated" ? reputationRecord() : null,
  };

  const responses = await Promise.all([
    getAnchorsApiResult({ repository: anchorRepository }),
    getAnchorApiResult("unevaluated", { repository: anchorRepository }),
    getCorridorsApiResult({ repository: corridorRepository }),
    getCorridorApiResult("usdc-us-brl-br", { repository: corridorRepository }),
    getRatesApiResult("usdc-us-brl-br", {
      now: () => EVALUATED_AT,
      readLatestRate: (slug, { evaluatedAt }) =>
        getLatestRate(slug, evaluatedAt),
    }),
    getReputationApiResult({ repository: reputationRepository }),
    getAnchorReputationApiResult("unevaluated", { repository: reputationRepository }),
  ]);

  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.doesNotThrow(() => JSON.stringify(response.body));
  }

  const [anchors, anchor, corridors, corridor, rates, reputation, reputationDetail] = responses;
  if (
    anchors.status !== 200 || anchor.status !== 200 || corridors.status !== 200
    || corridor.status !== 200 || rates.status !== 200
    || reputation.status !== 200 || reputationDetail.status !== 200
  ) return;

  assert.deepEqual(Object.keys(anchors.body), ["anchors", "count"]);
  assert.deepEqual(Object.keys(anchor.body), ["anchor"]);
  assert.deepEqual(Object.keys(corridors.body), ["corridors", "count"]);
  assert.deepEqual(Object.keys(corridor.body), ["corridor"]);
  assert.deepEqual(Object.keys(rates.body), [
    "corridor",
    "evaluatedAt",
    "state",
    "medianRate",
    "sourceCount",
    "freshSourceCount",
    "reviewedCandidateConfiguration",
    "medianRequirement",
    "observations",
  ]);
  assert.deepEqual(Object.keys(reputation.body), ["reputation", "count"]);
  assert.deepEqual(Object.keys(reputationDetail.body), ["reputation"]);
});

test("rates never fabricate a median when fresh evidence is insufficient", async () => {
  const result = await getRatesApiResult("usdc-us-brl-br", {
    now: () => EVALUATED_AT,
    readLatestRate: (slug, { evaluatedAt }) =>
      getLatestRate(slug, evaluatedAt, [rateObservation("zeam")]),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.state, "insufficient_fresh_sources");
  assert.equal(result.body.medianRate, null);
  assert.equal(result.body.freshSourceCount, 1);
});

test("reputation keeps unevaluated anchors explicitly scoreless", async () => {
  const result = await getAnchorReputationApiResult("unevaluated", {
    repository: {
      findAll: async () => [reputationRecord()],
      findBySlug: async () => reputationRecord(),
    },
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.reputation.state, "not_evaluated");
  assert.equal(result.body.reputation.score, null);
  assert.equal(result.body.reputation.scoreBand, null);
  assert.equal(result.body.reputation.evidence, null);
});

test("valid unknown slugs return 404 across all slug routes", async () => {
  const [anchor, corridor, reputation, rates] = await Promise.all([
    getAnchorApiResult("missing-anchor", {
      repository: {
        findAll: async () => [],
        findBySlug: async () => null,
      },
    }),
    getCorridorApiResult("missing-corridor", {
      repository: { findBySlug: async () => null },
    }),
    getAnchorReputationApiResult("missing-anchor", {
      repository: {
        findAll: async () => [],
        findBySlug: async () => null,
      },
    }),
    getRatesApiResult("missing-corridor", {
      readLatestRate: async (corridorSlug) => ({
        ok: false,
        corridorSlug,
        code: "CORRIDOR_NOT_FOUND" as const,
      }),
    }),
  ]);

  assert.equal(anchor.status, 404);
  assert.equal(corridor.status, 404);
  assert.equal(reputation.status, 404);
  assert.equal(rates.status, 404);
});

function anchorRecord(slug: string) {
  return {
    slug,
    name: "Unevaluated Anchor",
    homeDomain: "unevaluated.example",
    status: "LIVE" as const,
    seps: [1, 24],
    corridorCount: 1,
    corridors: [{
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }],
  };
}

function corridorRecord() {
  return {
    slug: "usdc-us-brl-br",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchorCount: 1,
  };
}

function corridorDetailRecord() {
  return {
    ...corridorRecord(),
    anchors: [{
      slug: "unevaluated",
      name: "Unevaluated Anchor",
      homeDomain: "unevaluated.example",
      status: "LIVE" as const,
      seps: [1, 24],
    }],
  };
}

function reputationRecord() {
  return { slug: "unevaluated", name: "Unevaluated Anchor", reputationScore: null };
}

async function getLatestRate(
  slug: string,
  evaluatedAt: Date,
  observations = [rateObservation("zeam"), rateObservation("anchor-b")],
) {
  const repository: LatestRateRepository = {
    findCorridorBySlug: async () => ({
      id: "controlled-corridor",
      slug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    }),
    findLatestObservations: async () => observations,
  };

  const { readLatestCorridorRate } = await import("@/lib/rates/latestRateReadModel");
  return readLatestCorridorRate(slug, { repository, evaluatedAt });
}

function rateObservation(anchorSlug: string) {
  return {
    id: `${anchorSlug}-latest`,
    anchorSlug,
    anchorName: anchorSlug === "zeam" ? "Zeam" : "Anchor B",
    rate: "1.25",
    sourceAmount: "1",
    destinationAmount: "1.25",
    fee: "0",
    capturedAt: new Date(EVALUATED_AT.getTime() - 1_000),
  };
}
