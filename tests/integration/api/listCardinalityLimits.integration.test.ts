/**
 * Cardinality-boundary regression tests for the public evidence list routes
 * (Issue #347).
 *
 * The public directory APIs (`/api/anchors`, `/api/corridors`) bound caller
 * supplied page sizes with `MAX_PAGE_LIMIT`. These tests pin the exact boundary
 * behaviour so a future change cannot silently make a list response unbounded
 * or widen the accepted `limit` range.
 *
 * The contract exercised here is the existing one:
 * - `limit` at `MAX_PAGE_LIMIT` is accepted and returns at most that many rows.
 * - `limit` above `MAX_PAGE_LIMIT` is rejected before repository access with
 *   the stable `invalid_pagination` error envelope.
 * - Omitting pagination preserves the documented unbounded directory default.
 * - Offsets beyond the collection size return an empty, well-formed page.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { getAnchorsApiResult } from "@/lib/api/anchors";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import type {
  AnchorDirectoryRecord,
  AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
import type {
  CorridorDirectoryRecord,
  CorridorDirectoryRepository,
} from "@/lib/api/corridorRepository";
import { MAX_PAGE_LIMIT } from "@/lib/api/pagination";

const SUPPORTED = String(MAX_PAGE_LIMIT);
const ABOVE_SUPPORTED = String(MAX_PAGE_LIMIT + 1);
const RECORD_COUNT = MAX_PAGE_LIMIT * 2;

function anchorRecords(count: number): readonly AnchorDirectoryRecord[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const slug = `anchor-${String(index).padStart(3, "0")}`;
      return Object.freeze({
        slug,
        name: slug,
        homeDomain: `${slug}.example`,
        status: "LIVE" as const,
        seps: Object.freeze([1, 38]),
        corridorCount: 1,
      });
    }),
  );
}

function corridorRecords(count: number): readonly CorridorDirectoryRecord[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const slug = `corridor-${String(index).padStart(3, "0")}`;
      return Object.freeze({
        slug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
        anchorCount: 1,
      });
    }),
  );
}

function anchorRepository(
  records: readonly AnchorDirectoryRecord[],
  onAccess: () => void = () => {},
): AnchorDirectoryRepository {
  return Object.freeze({
    findAll: async () => {
      onAccess();
      return records;
    },
    findBySlug: async () => null,
  });
}

function corridorRepository(
  records: readonly CorridorDirectoryRecord[],
  onAccess: () => void = () => {},
): CorridorDirectoryRepository {
  return Object.freeze({
    findAll: async () => {
      onAccess();
      return records;
    },
  });
}

test("anchor list accepts the exact supported limit and returns only that many rows", async () => {
  const result = await getAnchorsApiResult(
    { repository: anchorRepository(anchorRecords(RECORD_COUNT)) },
    { limit: SUPPORTED, offset: null },
  );

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.count, MAX_PAGE_LIMIT);
  assert.equal(result.body.anchors.length, MAX_PAGE_LIMIT);
  assert.equal(result.body.anchors[0]?.slug, "anchor-000");
  assert.equal(result.body.anchors.at(-1)?.slug, "anchor-099");
});

test("corridor list accepts the exact supported limit and returns only that many rows", async () => {
  const result = await getCorridorsApiResult(
    { repository: corridorRepository(corridorRecords(RECORD_COUNT)) },
    { limit: SUPPORTED, offset: null },
  );

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.count, MAX_PAGE_LIMIT);
  assert.equal(result.body.corridors.length, MAX_PAGE_LIMIT);
  assert.equal(result.body.corridors[0]?.slug, "corridor-000");
  assert.equal(result.body.corridors.at(-1)?.slug, "corridor-099");
});

test("one row above the supported limit is rejected before either list repository is read", async () => {
  let anchorAccesses = 0;
  let corridorAccesses = 0;

  const anchors = await getAnchorsApiResult(
    {
      repository: anchorRepository(anchorRecords(RECORD_COUNT), () => {
        anchorAccesses += 1;
      }),
    },
    { limit: ABOVE_SUPPORTED, offset: null },
  );
  const corridors = await getCorridorsApiResult(
    {
      repository: corridorRepository(corridorRecords(RECORD_COUNT), () => {
        corridorAccesses += 1;
      }),
    },
    { limit: ABOVE_SUPPORTED, offset: null },
  );

  for (const result of [anchors, corridors]) {
    assert.equal(result.status, 400);
    if (result.status !== 400) continue;
    assert.equal(result.body.error.code, "invalid_pagination");
    assert.match(result.body.error.message, new RegExp(String(MAX_PAGE_LIMIT)));
  }
  assert.equal(anchorAccesses, 0, "the anchors repository must not run for an oversized limit");
  assert.equal(corridorAccesses, 0, "the corridors repository must not run for an oversized limit");
});

test("omitting pagination preserves the documented directory default for both lists", async () => {
  const anchors = await getAnchorsApiResult({
    repository: anchorRepository(anchorRecords(RECORD_COUNT)),
  });
  const corridors = await getCorridorsApiResult({
    repository: corridorRepository(corridorRecords(RECORD_COUNT)),
  });

  assert.equal(anchors.status, 200);
  assert.equal(corridors.status, 200);
  if (anchors.status !== 200 || corridors.status !== 200) return;
  assert.equal(anchors.body.count, RECORD_COUNT);
  assert.equal(corridors.body.count, RECORD_COUNT);
});

test("an offset beyond the collection returns an empty bounded page on both lists", async () => {
  const anchors = await getAnchorsApiResult(
    { repository: anchorRepository(anchorRecords(3)) },
    { limit: SUPPORTED, offset: String(RECORD_COUNT) },
  );
  const corridors = await getCorridorsApiResult(
    { repository: corridorRepository(corridorRecords(3)) },
    { limit: SUPPORTED, offset: String(RECORD_COUNT) },
  );

  assert.deepEqual(anchors, { status: 200, body: { anchors: [], count: 0 } });
  assert.deepEqual(corridors, { status: 200, body: { corridors: [], count: 0 } });
});

test("the supported bound is identical across the public evidence list routes", () => {
  assert.equal(MAX_PAGE_LIMIT, 100);
});
