import assert from "node:assert/strict";
import test from "node:test";

import { getAnchorsApiResult } from "@/lib/api/anchors";

test("empty anchor directory returns successful immutable response", async () => {
  const result = await getAnchorsApiResult({
    repository: { findAll: async () => [] },
  });

  assert.deepEqual(result, { status: 200, body: { anchors: [], count: 0 } });
  assert.equal(Object.isFrozen(result.body), true);
  if (result.status === 200) assert.equal(Object.isFrozen(result.body.anchors), true);
});

test("anchor serialization maps internal fields to public API format", async () => {
  const result = await getAnchorsApiResult({
    repository: { findAll: async () => [
      { slug: "zulu", name: "Zulu", homeDomain: "zulu.example", status: "LIVE", seps: [1, 10, 38], corridorCount: 5 },
    ] },
  });

  assert.deepEqual(result.body, {
    anchors: [{
      slug: "zulu",
      name: "Zulu",
      homeDomain: "zulu.example",
      status: "LIVE",
      seps: [1, 10, 38],
      isTransferCapable: false,
      corridorCount: 5,
    }],
    count: 1,
  });
  assert.equal("id" in result.body.anchors[0]!, false);
});

test("anchors are deterministically ordered by slug", async () => {
  const result = await getAnchorsApiResult({
    repository: { findAll: async () => [
      { slug: "alpha", name: "Alpha", homeDomain: "alpha.example", status: "LIVE", seps: [1, 24], corridorCount: 3 },
      { slug: "zulu", name: "Zulu", homeDomain: "zulu.example", status: "LIVE", seps: [1, 10, 38], corridorCount: 7 },
      { slug: "beta", name: "Beta", homeDomain: "beta.example", status: "LIVE", seps: [6], corridorCount: 1 },
    ] },
  });

  assert.deepEqual(result.body.anchors.map(({ slug }) => slug), [
    "alpha",
    "beta",
    "zulu",
  ]);
});

test("repository failures return stable safe error envelope", async () => {
  const result = await getAnchorsApiResult({
    repository: {
      findAll: async () => {
        throw new Error("DATABASE_URL=secret SQL failure");
      },
    },
  });

  assert.deepEqual(result, {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Unable to load anchors." },
    },
  });
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
