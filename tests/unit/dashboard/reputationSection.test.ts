import assert from "node:assert/strict";
import test from "node:test";

import { getReputationApiResult, getAnchorReputationApiResult } from "@/lib/api/reputation";
import type {
  ReputationApiAnchorRecord,
  ReputationApiRepository,
  ReputationApiScoreRecord,
} from "@/lib/api/reputationRepository";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";

const COMPUTED_AT = new Date("2026-08-31T13:54:34.979Z");

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
  overrides: Partial<ReputationApiScoreRecord> = {},
): ReputationApiScoreRecord {
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
  bySlug: ReputationApiAnchorRecord | null = null,
  failure?: unknown,
): ReputationApiRepository {
  return Object.freeze({
    findAll: async () => {
      if (failure !== undefined) throw failure;
      return records;
    },
    findBySlug: async () => {
      if (failure !== undefined) throw failure;
      return bySlug;
    },
  });
}

function staleStore(): StaleEvidenceStore {
  return Object.freeze({
    read: async () => Object.freeze({
      payload: Object.freeze({ reputation: Object.freeze([]), count: 0 }),
      generatedAt: COMPUTED_AT.toISOString(),
      expiresAt: new Date(COMPUTED_AT.getTime() + 60_000).toISOString(),
      sourceTimes: Object.freeze([COMPUTED_AT.toISOString()]),
    }),
    write: async () => {},
  });
}

test("empty anchor directory is a successful immutable reputation response", async () => {
  const result = await getReputationApiResult({ repository: repository([]) });

  assert.deepEqual(result, { status: 200, body: { reputation: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.reputation), true);
});

test("anchor serialization maps internal fields to public API format", async () => {
  const result = await getReputationApiResult({ repository: repository([anchor("zeam", score())]) });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    reputation: [{
      anchor: { slug: "zeam", name: "Zeam" },
      state: "established",
      score: 90,
      scoreBand: "amber",
      evidence: { outcomeCount: 30 },
      metrics: {
        fillRate7d: null,
        fillRate30d: null,
        fillRate90d: null,
        settleP50Ms: null,
        settleP95Ms: null,
        slippageP50: null,
        slippageP95: null,
      },
      computedAt: COMPUTED_AT.toISOString(),
    }],
    count: 1,
  });
  assert.equal(Object.isFrozen(result.body.reputation[0]), true);
});

test("anchor ordering is deterministic and serialization excludes internal fields", async () => {
  const result = await getReputationApiResult({ repository: repository([
    anchor("zeam", score()),
    anchor("cowrie", null),
    anchor("moneygram", score({ state: "INSUFFICIENT_DATA", compositeScore: null, scoreBand: null })),
  ]) });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body.reputation.map(({ anchor: result }) => result.slug), [
    "cowrie",
    "moneygram",
    "zeam",
  ]);
  assert.equal(Object.isFrozen(result.body.reputation[0]), true);
  assert.doesNotThrow(() => JSON.stringify(result.body));
  const serialized = JSON.stringify(result.body);
  for (const forbidden of ["anchorId", "INSUFFICIENT_DATA", "rateSnapshots", "transferOutcomes"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("detail validates slugs before repository access and distinguishes unknown anchors", async () => {
  for (const slug of ["", "../cowrie", " Cowrie ", "bad--slug", "a".repeat(101)]) {
    const result = await getAnchorReputationApiResult(slug, {
      repository: repository([], null),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "invalid_anchor_slug");
  }

  const missing = await getAnchorReputationApiResult("not-a-real-anchor", {
    repository: repository([], null),
  });
  assert.deepEqual(missing, {
    status: 404,
    body: { error: { code: "anchor_not_found", message: "Anchor not found." } },
  });
});

test("repository failures fallback to stale evidence (returns 200)", async () => {
  const transientFailure = Object.assign(new Error("DATABASE_URL=secret"), { code: "P1001" });

  const list = await getReputationApiResult({
    repository: repository([], null, transientFailure),
    staleEvidenceStore: staleStore(),
    now: () => COMPUTED_AT,
  });

  // The API falls back to stale evidence on a transient database failure.
  assert.equal(list.status, 200);
  assert.equal(list.body.reputation.length, 0);
  assert.equal(JSON.stringify(list).includes("secret"), false);
});

test("routes are GET-only dynamic no-store handlers", async () => {
  const listRoute = await import("@/app/api/reputation/route") as {
    dynamic?: string;
  };
  const detailRoute = await import("@/app/api/reputation/[slug]/route") as {
    dynamic?: string;
    GET: (
      request: Request,
      context: { params: Promise<{ slug: string }> },
    ) => Promise<Response>;
  };

  for (const route of [listRoute, detailRoute]) {
    assert.equal(route.dynamic, "force-dynamic");
    assert.equal("POST" in route, false);
    assert.equal("PUT" in route, false);
    assert.equal("PATCH" in route, false);
    assert.equal("DELETE" in route, false);
  }

  const response = await detailRoute.GET(
    new Request("http://localhost/api/reputation/bad--slug"),
    { params: Promise.resolve({ slug: "bad--slug" }) },
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
