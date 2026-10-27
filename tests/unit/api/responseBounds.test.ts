import assert from "node:assert/strict";
import test from "node:test";

import { getAnchorsApiResult } from "@/lib/api/anchors";
import type { AnchorDirectoryRecord } from "@/lib/api/anchorRepository";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import type { CorridorDirectoryRecord } from "@/lib/api/corridorRepository";
import { publicApiJsonResponse } from "@/lib/api/http";
import { MAX_PAGE_LIMIT, NO_PAGINATION_QUERY, type PaginationQuery } from "@/lib/api/pagination";

type Fixture = AnchorDirectoryRecord & CorridorDirectoryRecord;
const slug = (index: number) => `record-${String(index).padStart(6, "0")}`;
const fixture = (index: number): Fixture => ({
  slug: slug(index), name: `Anchor ${index}`, homeDomain: `anchor-${index}.example`,
  status: "LIVE", seps: [38, 1], corridorCount: index,
  assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR", anchorCount: index,
});

const endpoints = [
  {
    name: "anchors", field: "name" as const,
    run: (records: readonly Fixture[], query: PaginationQuery, onRead: () => void) => getAnchorsApiResult({
      repository: { findAll: async () => { onRead(); return records; }, findBySlug: async () => null },
    }, query),
    serialize: (index: number) => ({
      slug: slug(index), name: `Anchor ${index}`, homeDomain: `anchor-${index}.example`,
      status: "LIVE", seps: [1, 38], isTransferCapable: false, corridorCount: index,
    }),
  },
  {
    name: "corridors", field: "assetCodeFrom" as const,
    run: (records: readonly Fixture[], query: PaginationQuery, onRead: () => void) => getCorridorsApiResult({
      repository: { findAll: async () => { onRead(); return records; } },
    }, query),
    serialize: (index: number) => ({
      slug: slug(index), sourceAsset: "USDC", sourceCountry: "US",
      destinationAsset: "BRL", destinationCountry: "BR", anchorCount: index,
    }),
  },
];

for (const endpoint of endpoints) {
  for (const size of [0, 1, MAX_PAGE_LIMIT - 1, MAX_PAGE_LIMIT, MAX_PAGE_LIMIT + 1, MAX_PAGE_LIMIT * 10 + 1]) {
    for (const offset of [0, MAX_PAGE_LIMIT, size + 1]) {
      test(`${endpoint.name}: size ${size}, offset ${offset} serializes only the bounded page`, async () => {
        const indexes = Array.from({ length: size }, (_, index) => index);
        const selected = indexes.slice(offset, offset + MAX_PAGE_LIMIT);
        let serialized = 0;
        const records = Object.freeze(indexes.map((index) => {
          const record = fixture(index);
          for (const field of Object.keys(record) as (keyof Fixture)[]) {
            if (field === "slug") continue; // Slugs are needed to establish page ordering.
            const value = record[field];
            Object.defineProperty(record, field, { get() {
              if (field === endpoint.field) serialized += 1;
              assert.ok(selected.includes(index), "off-page fields must never be serialized");
              return value;
            } });
          }
          return Object.freeze(record);
        }).reverse());
        const originalOrder = records.map((record) => record.slug);
        let reads = 0;
        const result = await endpoint.run(records, { limit: String(MAX_PAGE_LIMIT), offset: String(offset) }, () => { reads += 1; });
        assert.equal(result.status, 200);
        assert.equal(reads, 1);
        assert.equal(serialized, selected.length);
        const response = publicApiJsonResponse(result);
        assert.deepEqual(await response.json(), {
          [endpoint.name]: selected.map((index) => endpoint.serialize(index)), count: selected.length,
        });
        assert.deepEqual(records.map((record) => record.slug), originalOrder);
      });
    }
  }

  test(`${endpoint.name}: no limit and offset-only preserve complete responses without invented truncation metadata`, async () => {
    const indexes = Array.from({ length: MAX_PAGE_LIMIT + 1 }, (_, index) => index);
    const records = indexes.map(fixture).reverse();
    for (const query of [NO_PAGINATION_QUERY, { limit: null, offset: "1" }]) {
      const selected = query.offset === null ? indexes : indexes.slice(1);
      const result = await endpoint.run(records, query, () => {});
      assert.equal(result.status, 200);
      assert.deepEqual(result.body, {
        [endpoint.name]: selected.map((index) => endpoint.serialize(index)), count: selected.length,
      });
    }
  });

  test(`${endpoint.name}: consecutive pages reconstruct a boundary-crossing dataset without duplicates`, async () => {
    const indexes = Array.from({ length: MAX_PAGE_LIMIT + 1 }, (_, index) => index);
    const records = indexes.map(fixture).reverse();
    for (const limit of [1, MAX_PAGE_LIMIT - 1, MAX_PAGE_LIMIT]) {
      const combined: unknown[] = [];
      for (let offset = 0; offset < records.length; offset += limit) {
        const selected = indexes.slice(offset, offset + limit);
        const result = await endpoint.run(records, { limit: String(limit), offset: String(offset) }, () => {});
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { [endpoint.name]: selected.map((index) => endpoint.serialize(index)), count: selected.length });
        const body = await publicApiJsonResponse(result).json();
        combined.push(...body[endpoint.name]);
      }
      assert.deepEqual(combined, indexes.map((index) => endpoint.serialize(index)));
    }
  });

  test(`${endpoint.name}: invalid limits fail safely before loading a dataset`, async () => {
    for (const limit of ["0", "-1", String(MAX_PAGE_LIMIT + 1), "9".repeat(400)]) {
      const result = await endpoint.run([], { limit, offset: null }, () => assert.fail("must not read evidence"));
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: {
        code: "invalid_pagination",
        message: `limit must be a positive integer no greater than ${MAX_PAGE_LIMIT}.`,
      } });
    }
  });
}
