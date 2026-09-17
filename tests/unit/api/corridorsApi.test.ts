import assert from "node:assert/strict";
import test from "node:test";

import * as detailRoute from "@/app/api/corridors/[slug]/route";
import * as listRoute from "@/app/api/corridors/route";
import {
  getCorridorApiResult,
  getCorridorsApiResult,
  serializeCorridorDetail,
  serializeCorridors,
} from "@/lib/api/corridors";
import type {
  CorridorDetailRecord,
  CorridorDetailRepository,
  CorridorDirectoryRecord,
} from "@/lib/api/corridorRepository";

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

test("detail serializes persisted associated anchors deterministically without trusting stored capability", () => {
  const sep38Only = {
    ...anchor("zulu", [38, 10, 1]),
    isTransferCapable: true,
  };
  const sep24 = {
    ...anchor("alpha", [24, 1]),
    isTransferCapable: false,
  };
  const detail = serializeCorridorDetail(corridorDetail([sep38Only, sep24]));

  assert.deepEqual(detail, {
    slug: "usdc-us-brl-br",
    sourceAsset: "USDC",
    sourceCountry: "US",
    destinationAsset: "BRL",
    destinationCountry: "BR",
    anchorCount: 2,
    anchors: [
      {
        slug: "alpha",
        name: "Alpha",
        homeDomain: "alpha.example",
        status: "LIVE",
        seps: [1, 24],
        isTransferCapable: true,
      },
      {
        slug: "zulu",
        name: "Zulu",
        homeDomain: "zulu.example",
        status: "LIVE",
        seps: [1, 10, 38],
        isTransferCapable: false,
      },
    ],
  });
  assert.equal(detail.anchorCount, detail.anchors.length);
  assert.equal(Object.isFrozen(detail), true);
  assert.equal(Object.isFrozen(detail.anchors), true);
  assert.equal(Object.isFrozen(detail.anchors[0]), true);
  assert.equal(Object.isFrozen(detail.anchors[0]?.seps), true);
});

test("detail derives transfer capability only from SEP-6, SEP-24, or SEP-31", () => {
  const cases = [
    { name: "SEP-6", seps: [6], expected: true },
    { name: "SEP-24", seps: [24], expected: true },
    { name: "SEP-31", seps: [31], expected: true },
    { name: "non-transfer SEPs", seps: [1, 10, 38], expected: false },
  ] as const;

  for (const value of cases) {
    const detail = serializeCorridorDetail(corridorDetail([
      anchor("tested", value.seps),
    ]));
    assert.equal(detail.anchors[0]?.isTransferCapable, value.expected, value.name);
  }
});

test("persisted detail with no associated anchors is a successful empty response", async () => {
  const record = corridorDetail([]);
  const result = await getCorridorApiResult(record.slug, {
    repository: detailRepository(record),
  });

  assert.deepEqual(result, {
    status: 200,
    body: {
      corridor: {
        slug: "usdc-us-brl-br",
        sourceAsset: "USDC",
        sourceCountry: "US",
        destinationAsset: "BRL",
        destinationCountry: "BR",
        anchorCount: 0,
        anchors: [],
      },
    },
  });
});

test("malformed detail slugs return exact 400 errors before repository access", async () => {
  for (const slug of ["", "../corridor", " USDC ", "bad--slug", "a".repeat(101)]) {
    let accessed = false;
    const result = await getCorridorApiResult(slug, {
      repository: {
        findBySlug: async () => {
          accessed = true;
          return null;
        },
      },
    });

    assert.deepEqual(result, {
      status: 400,
      body: {
        error: {
          code: "invalid_corridor_slug",
          message: "A valid corridor slug is required.",
        },
      },
    });
    assert.equal(accessed, false);
  }
});

test("valid unknown detail slug returns the exact safe 404", async () => {
  const result = await getCorridorApiResult("unknown-corridor", {
    repository: detailRepository(null),
  });

  assert.deepEqual(result, {
    status: 404,
    body: {
      error: { code: "corridor_not_found", message: "Corridor not found." },
    },
  });
});

test("detail repository failures return the exact safe 500 without leaking internals", async () => {
  const result = await getCorridorApiResult("usdc-us-brl-br", {
    repository: detailRepository(null, new Error("DATABASE_URL=secret SQL")),
  });

  assert.deepEqual(result, {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unable to load corridor." },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("both routes export GET only and explicitly disable caching", async () => {
  for (const route of [listRoute, detailRoute]) {
    assert.equal(route.dynamic, "force-dynamic");
    assert.equal("POST" in route, false);
    assert.equal("PUT" in route, false);
    assert.equal("PATCH" in route, false);
    assert.equal("DELETE" in route, false);
  }

  const malformed = await detailRoute.GET(
    new Request("http://localhost/api/corridors/bad--slug"),
    { params: Promise.resolve({ slug: "bad--slug" }) },
  );
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
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

function anchor(slug: string, seps: readonly number[]) {
  return Object.freeze({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    homeDomain: `${slug}.example`,
    status: "LIVE" as const,
    seps: Object.freeze([...seps]),
  });
}

function corridorDetail(
  anchors: CorridorDetailRecord["anchors"],
): CorridorDetailRecord {
  return Object.freeze({
    slug: "usdc-us-brl-br",
    assetCodeFrom: "USDC",
    countryFrom: "US",
    assetCodeTo: "BRL",
    countryTo: "BR",
    anchors: Object.freeze([...anchors]),
  });
}

function detailRepository(
  record: CorridorDetailRecord | null,
  error?: Error,
): CorridorDetailRepository {
  return Object.freeze({
    findBySlug: async () => {
      if (error) throw error;
      return record;
    },
  });
}
