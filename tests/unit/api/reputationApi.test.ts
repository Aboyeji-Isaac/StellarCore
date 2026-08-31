import assert from "node:assert/strict";
import test from "node:test";

import * as detailRoute from "@/app/api/reputation/[slug]/route";
import * as listRoute from "@/app/api/reputation/route";
import {
  getAnchorReputationApiResult,
  getReputationApiResult,
  serializeReputation,
  serializeReputationList,
} from "@/lib/api/reputation";
import type {
  ReputationApiAnchorRecord,
  ReputationApiRepository,
} from "@/lib/api/reputationRepository";

const COMPUTED_AT = new Date("2026-08-31T13:54:34.979Z");

test("empty anchor directory is a successful immutable reputation response", async () => {
  const result = await getReputationApiResult({ repository: repository([]) });
  assert.deepEqual(result, { status: 200, body: { reputation: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.reputation), true);
});

test("unevaluated anchors remain visibly not_evaluated without manufactured values", () => {
  const value = serializeReputation(anchor("unevaluated", null));
  assert.deepEqual(value, {
    anchor: { slug: "unevaluated", name: "Unevaluated" },
    state: "not_evaluated",
    score: null,
    scoreBand: null,
    evidence: null,
    metrics: null,
    computedAt: null,
  });
});

test("insufficient evidence preserves null score and maps persistence state", () => {
  const value = serializeReputation(anchor("cowrie", score({
    state: "INSUFFICIENT_DATA",
    compositeScore: null,
    scoreBand: null,
    sampleSize: 0,
  })));
  assert.equal(value.state, "insufficient_evidence");
  assert.equal(value.score, null);
  assert.equal(value.scoreBand, null);
  assert.equal(value.evidence?.outcomeCount, 0);
  assert.equal(value.computedAt, COMPUTED_AT.toISOString());
});

test("established rows map score bands and persisted explanatory metrics", () => {
  const value = serializeReputation(anchor("zeam", score({
    state: "OK",
    compositeScore: 95,
    scoreBand: "GREEN",
    sampleSize: 30,
    fillRate30d: 0.9,
    settleP50Ms: 1_000,
    slippageP95: 0.02,
  })));
  assert.deepEqual(value, {
    anchor: { slug: "zeam", name: "Zeam" },
    state: "established",
    score: 95,
    scoreBand: "green",
    evidence: { outcomeCount: 30 },
    metrics: {
      fillRate7d: null,
      fillRate30d: 0.9,
      fillRate90d: null,
      settleP50Ms: 1_000,
      settleP95Ms: null,
      slippageP50: null,
      slippageP95: 0.02,
    },
    computedAt: COMPUTED_AT.toISOString(),
  });
});

test("list ordering is deterministic and serialization excludes internal fields", () => {
  const body = serializeReputationList([
    anchor("zeam", score()),
    anchor("cowrie", null),
    anchor("moneygram", score({ state: "INSUFFICIENT_DATA", compositeScore: null, scoreBand: null })),
  ]);
  assert.deepEqual(body.reputation.map(({ anchor: result }) => result.slug), [
    "cowrie",
    "moneygram",
    "zeam",
  ]);
  assert.equal(Object.isFrozen(body.reputation[0]), true);
  assert.doesNotThrow(() => JSON.stringify(body));
  const serialized = JSON.stringify(body);
  for (const forbidden of ["anchorId", "INSUFFICIENT_DATA", "rateSnapshots", "transferOutcomes"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("detail validates slugs before repository access and distinguishes unknown anchors", async () => {
  for (const slug of ["", "../cowrie", " Cowrie ", "bad--slug", "a".repeat(101)]) {
    let accessed = false;
    const result = await getAnchorReputationApiResult(slug, {
      repository: {
        findAll: async () => [],
        findBySlug: async () => {
          accessed = true;
          return null;
        },
      },
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid_anchor_slug");
    assert.equal(accessed, false);
  }

  const missing = await getAnchorReputationApiResult("not-a-real-anchor", {
    repository: repository([], null),
  });
  assert.deepEqual(missing, {
    status: 404,
    body: { error: { code: "anchor_not_found", message: "Anchor not found." } },
  });
});

test("repository failures are safe and routes are GET-only dynamic no-store handlers", async () => {
  const list = await getReputationApiResult({
    repository: repository([], null, new Error("DATABASE_URL=secret")),
  });
  const detail = await getAnchorReputationApiResult("zeam", {
    repository: repository([], null, undefined, new Error("Prisma secret")),
  });
  assert.equal(list.status, 500);
  assert.equal(detail.status, 500);
  assert.equal(JSON.stringify({ list, detail }).includes("secret"), false);

  for (const route of [listRoute, detailRoute]) {
    assert.equal(route.dynamic, "force-dynamic");
    assert.equal("POST" in route, false);
    assert.equal("PUT" in route, false);
    assert.equal("PATCH" in route, false);
    assert.equal("DELETE" in route, false);
  }
  const response = await detailRoute.GET(new Request("http://localhost/api/reputation/bad--slug"), {
    params: Promise.resolve({ slug: "bad--slug" }),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

function anchor(
  slug: string,
  reputationScore: ReputationApiAnchorRecord["reputationScore"],
): ReputationApiAnchorRecord {
  return Object.freeze({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    reputationScore,
  });
}

function score(
  overrides: Partial<NonNullable<ReputationApiAnchorRecord["reputationScore"]>> = {},
): NonNullable<ReputationApiAnchorRecord["reputationScore"]> {
  return Object.freeze({
    compositeScore: 90,
    scoreBand: "AMBER",
    fillRate7d: null,
    fillRate30d: null,
    fillRate90d: null,
    settleP50Ms: null,
    settleP95Ms: null,
    slippageP50: null,
    slippageP95: null,
    sampleSize: 30,
    state: "OK",
    computedAt: COMPUTED_AT,
    ...overrides,
  });
}

function repository(
  records: readonly ReputationApiAnchorRecord[],
  record: ReputationApiAnchorRecord | null = null,
  listError?: Error,
  detailError?: Error,
): ReputationApiRepository {
  return Object.freeze({
    findAll: async () => {
      if (listError) throw listError;
      return records;
    },
    findBySlug: async () => {
      if (detailError) throw detailError;
      return record;
    },
  });
}
