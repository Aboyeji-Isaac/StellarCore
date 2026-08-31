import assert from "node:assert/strict";
import test from "node:test";

import * as detailRoute from "@/app/api/anchors/[slug]/route";
import * as listRoute from "@/app/api/anchors/route";
import {
  getAnchorApiResult,
  getAnchorsApiResult,
  serializeAnchorDetail,
  serializeAnchors,
} from "@/lib/api/anchors";
import type {
  AnchorDetailRecord,
  AnchorDirectoryRecord,
  AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";

test("empty persisted directory is a successful immutable response", async () => {
  const result = await getAnchorsApiResult({ repository: repository([]) });

  assert.deepEqual(result, { status: 200, body: { anchors: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.anchors), true);
});

test("one anchor serializes sorted SEPs and corridor count without UUIDs", () => {
  const body = serializeAnchors([summary("zeam", [38, 1, 24, 10, 31], 1)]);

  assert.deepEqual(body, {
    anchors: [{
      slug: "zeam",
      name: "Zeam",
      homeDomain: "zeam.example",
      status: "LIVE",
      seps: [1, 10, 24, 31, 38],
      corridorCount: 1,
    }],
    count: 1,
  });
  assert.equal("id" in body.anchors[0]!, false);
  assert.doesNotThrow(() => JSON.stringify(body));
});

test("multiple anchors are deterministically ordered by slug", () => {
  const body = serializeAnchors([
    summary("zeam", [38], 1),
    summary("cowrie", [31, 1], 2),
    summary("moneygram", [24, 1], 3),
  ]);

  assert.deepEqual(body.anchors.map(({ slug }) => slug), [
    "cowrie",
    "moneygram",
    "zeam",
  ]);
  assert.deepEqual(body.anchors.map(({ corridorCount }) => corridorCount), [2, 3, 1]);
});

test("list repository failures return the stable safe error envelope", async () => {
  const result = await getAnchorsApiResult({
    repository: repository([], null, new Error("DATABASE_URL=secret SQL")),
  });

  assert.deepEqual(result, {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unable to load anchors." },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("valid detail serializes bounded sorted corridors with no internal data", async () => {
  const record = detail("zeam");
  const result = await getAnchorApiResult("zeam", {
    repository: repository([], record),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.deepEqual(result.body.anchor.corridors.map(({ slug }) => slug), [
    "ngnt-ng-ngn-ng",
    "usdc-us-brl-br",
  ]);
  assert.deepEqual(result.body.anchor.seps, [1, 10, 24, 31, 38]);
  const serialized = JSON.stringify(result.body);
  for (const forbidden of ["anchorId", "corridorId", "rateSnapshots", "reputationScore"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("detail serializer is immutable and JSON-safe", () => {
  const anchor = serializeAnchorDetail(detail("zeam"));
  assert.equal(Object.isFrozen(anchor), true);
  assert.equal(Object.isFrozen(anchor.seps), true);
  assert.equal(Object.isFrozen(anchor.corridors), true);
  assert.equal(Object.isFrozen(anchor.corridors[0]), true);
  assert.doesNotThrow(() => JSON.stringify(anchor));
});

test("malformed slugs return 400 before repository access", async () => {
  for (const slug of ["", "../zeam", " Zeam ", "bad--slug", "a".repeat(101)]) {
    let accessed = false;
    const result = await getAnchorApiResult(slug, {
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
});

test("unknown valid slug returns 404", async () => {
  const result = await getAnchorApiResult("not-a-real-anchor", {
    repository: repository([], null),
  });

  assert.deepEqual(result, {
    status: 404,
    body: { error: { code: "anchor_not_found", message: "Anchor not found." } },
  });
});

test("detail repository failures return 500 without leaking internals", async () => {
  const result = await getAnchorApiResult("zeam", {
    repository: repository([], null, undefined, new Error("Prisma DATABASE_URL secret")),
  });

  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "internal_error");
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("both routes export GET only and explicitly disable caching", async () => {
  for (const route of [listRoute, detailRoute]) {
    assert.equal(route.dynamic, "force-dynamic");
    assert.equal("POST" in route, false);
    assert.equal("PUT" in route, false);
    assert.equal("DELETE" in route, false);
  }

  const malformed = await detailRoute.GET(
    new Request("http://localhost/api/anchors/bad--slug"),
    { params: Promise.resolve({ slug: "bad--slug" }) },
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
});

function summary(
  slug: string,
  seps: readonly number[],
  corridorCount: number,
): AnchorDirectoryRecord {
  return Object.freeze({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    homeDomain: `${slug}.example`,
    status: "LIVE",
    seps: Object.freeze([...seps]),
    corridorCount,
  });
}

function detail(slug: string): AnchorDetailRecord {
  return Object.freeze({
    ...summary(slug, [38, 1, 31, 10, 24], 2),
    corridors: Object.freeze([
      Object.freeze({
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      }),
      Object.freeze({
        slug: "ngnt-ng-ngn-ng",
        assetCodeFrom: "NGNT",
        countryFrom: "NG",
        assetCodeTo: "NGN",
        countryTo: "NG",
      }),
    ]),
  });
}

function repository(
  records: readonly AnchorDirectoryRecord[],
  record: AnchorDetailRecord | null = null,
  listError?: Error,
  detailError?: Error,
): AnchorDirectoryRepository {
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
