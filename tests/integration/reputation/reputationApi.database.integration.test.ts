import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  getAnchorReputationApiResult,
  getReputationApiResult,
} from "@/lib/api/reputation";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_REPUTATION_API_DATABASE_INTEGRATION === "1";

test("isolated persisted current score and unevaluated anchor are read without engine evidence", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const evaluatedSlug = `test-reputation-api-evaluated-${suffix}`;
  const unevaluatedSlug = `test-reputation-api-unevaluated-${suffix}`;

  try {
    const evaluated = await db.anchor.create({
      data: {
        slug: evaluatedSlug,
        name: "Evaluated Reputation Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
      },
      select: { id: true },
    });
    await db.anchor.create({
      data: {
        slug: unevaluatedSlug,
        name: "Unevaluated Reputation Fixture",
        homeDomain: `unevaluated-${suffix}.example.com`,
        tomlUrl: `https://unevaluated-${suffix}.example.com/.well-known/stellar.toml`,
      },
    });
    await db.reputationScore.create({
      data: {
        anchorId: evaluated.id,
        compositeScore: 80,
        scoreBand: "AMBER",
        fillRate7d: 0.8,
        fillRate30d: 0.8,
        fillRate90d: 0.8,
        settleP50Ms: 1_000,
        settleP95Ms: 2_000,
        slippageP50: 0.01,
        slippageP95: 0.02,
        sampleSize: 30,
        state: "OK",
      },
    });

    const list = await getReputationApiResult();
    const evaluatedResult = await getAnchorReputationApiResult(evaluatedSlug);
    const unevaluatedResult = await getAnchorReputationApiResult(unevaluatedSlug);

    assert.equal(list.status, 200);
    assert.equal(evaluatedResult.status, 200);
    assert.equal(unevaluatedResult.status, 200);
    if (list.status !== 200 || evaluatedResult.status !== 200 || unevaluatedResult.status !== 200) return;
    assert.equal(list.body.reputation.find(({ anchor }) => anchor.slug === evaluatedSlug)?.score, 80);
    assert.equal(evaluatedResult.body.reputation.state, "established");
    assert.equal(evaluatedResult.body.reputation.evidence?.outcomeCount, 30);
    assert.equal(unevaluatedResult.body.reputation.state, "not_evaluated");
    assert.equal(unevaluatedResult.body.reputation.score, null);
  } finally {
    await db.reputationScore.deleteMany({ where: { anchor: { slug: evaluatedSlug } } });
    await db.anchor.deleteMany({ where: { slug: { in: [evaluatedSlug, unevaluatedSlug] } } });
    await db.$disconnect();
  }
});
