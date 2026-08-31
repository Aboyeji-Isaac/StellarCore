import assert from "node:assert/strict";
import test from "node:test";

import {
  getAnchorReputationApiResult,
  getReputationApiResult,
} from "@/lib/api/reputation";
import type { ReputationApiRepository } from "@/lib/api/reputationRepository";

test("controlled persisted current rows are exposed without scoring evidence reads", async () => {
  const calls: string[] = [];
  const repository: ReputationApiRepository = {
    findAll: async () => {
      calls.push("findAll");
      return [unevaluated(), established()];
    },
    findBySlug: async (slug) => {
      calls.push(`findBySlug:${slug}`);
      return slug === "established" ? established() : slug === "unevaluated" ? unevaluated() : null;
    },
  };

  const list = await getReputationApiResult({ repository });
  const detail = await getAnchorReputationApiResult("established", { repository });
  const empty = await getAnchorReputationApiResult("unevaluated", { repository });

  assert.equal(list.status, 200);
  assert.equal(detail.status, 200);
  assert.equal(empty.status, 200);
  if (list.status !== 200 || detail.status !== 200 || empty.status !== 200) return;
  assert.deepEqual(list.body.reputation.map(({ anchor }) => anchor.slug), ["established", "unevaluated"]);
  assert.equal(detail.body.reputation.state, "established");
  assert.equal(detail.body.reputation.score, 80);
  assert.equal(empty.body.reputation.state, "not_evaluated");
  assert.equal(empty.body.reputation.score, null);
  assert.deepEqual(calls, ["findAll", "findBySlug:established", "findBySlug:unevaluated"]);
  assert.equal(JSON.stringify({ list, detail, empty }).includes("rateSnapshot"), false);
});

function established() {
  return Object.freeze({
    slug: "established",
    name: "Established",
    reputationScore: Object.freeze({
      compositeScore: 80,
      scoreBand: "AMBER" as const,
      fillRate7d: 0.8,
      fillRate30d: 0.8,
      fillRate90d: 0.8,
      settleP50Ms: 1_000,
      settleP95Ms: 2_000,
      slippageP50: 0.01,
      slippageP95: 0.02,
      sampleSize: 30,
      state: "OK" as const,
      computedAt: new Date("2026-08-31T12:00:00.000Z"),
    }),
  });
}

function unevaluated() {
  return Object.freeze({ slug: "unevaluated", name: "Unevaluated", reputationScore: null });
}
