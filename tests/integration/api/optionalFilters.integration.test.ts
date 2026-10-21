import assert from "node:assert/strict";
import test from "node:test";

import { GET as getRates } from "@/app/api/rates/route";
import { GET as getHistory } from "@/app/api/rates/history/route";
import { GET as getAnchors } from "@/app/api/anchors/route";
import { GET as getCorridors } from "@/app/api/corridors/route";
import { getAnchorsApiResult } from "@/lib/api/anchors";
import { getCorridorsApiResult } from "@/lib/api/corridors";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { readPaginationQuery } from "@/lib/api/pagination";
import type { AnchorDirectoryRecord } from "@/lib/api/anchorRepository";
import type { CorridorDirectoryRecord } from "@/lib/api/corridorRepository";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";
const NO_STALE_STORE: StaleEvidenceStore = {
  read: async () => null,
  write: async () => {},
};
const anchors: readonly AnchorDirectoryRecord[] = [
  { slug: "alpha", name: "Alpha", homeDomain: "alpha.example", status: "LIVE", seps: [], corridorCount: 0 },
  { slug: "beta", name: "Beta", homeDomain: "beta.example", status: "LIVE", seps: [], corridorCount: 0 },
];
const corridors: readonly CorridorDirectoryRecord[] = [
  { slug: "alpha", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR", anchorCount: 0 },
  { slug: "beta", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "EUR", countryTo: "FR", anchorCount: 0 },
];

test("directory limit and offset query fixtures retain omission, reject blanks, and preserve valid slices", async () => {
  for (const path of ["anchors", "corridors"] as const) {
    let reads = 0;
    const load = (query: string) => {
      const pagination = readPaginationQuery(new URL(`http://localhost/api/${path}${query}`).searchParams);
      return path === "anchors"
        ? getAnchorsApiResult({ repository: { findAll: async () => { reads++; return anchors; }, findBySlug: async () => null } }, pagination)
        : getCorridorsApiResult({ repository: { findAll: async () => { reads++; return corridors; } } }, pagination);
    };

    const omitted = await load("");
    assert.equal(omitted.status, 200);
    assert.equal(omitted.body.count, 2);
    for (const [query, code] of [
      ["?limit=", "invalid_pagination"],
      ["?offset=", "invalid_pagination"],
      ["?limit=%20%20", "invalid_pagination"],
      ["?offset=%20%20", "invalid_pagination"],
      ["?limit=2&offset=oops", "invalid_pagination"],
    ] as const) {
      const result = await load(query);
      assert.equal(result.status, 400, `${path}${query}`);
      if (result.status === 400) assert.equal(result.body.error.code, code);
    }
    assert.equal(reads, 1, `${path} invalid filters must not broaden a repository read`);

    const valid = await load("?limit=1&offset=1");
    assert.equal(valid.status, 200);
    assert.equal(valid.body.count, 1);
    if (valid.status === 200) {
      const items = "anchors" in valid.body ? valid.body.anchors : valid.body.corridors;
      assert.equal(items[0]?.slug, "beta");
    }
  }
});

test("list route query parsing rejects empty and whitespace filters before database access", async () => {
  for (const [path, get] of [["anchors", getAnchors], ["corridors", getCorridors]] as const) {
    for (const query of ["?limit=", "?limit=%20", "?offset=", "?offset=%20"]) {
      const result = await get(new Request(`http://localhost/api/${path}${query}`));
      assert.equal(result.status, 400, `${path}${query}`);
      assert.equal((await result.json()).error.code, "invalid_pagination");
    }
  }
});

test("optional history days use 30 for omitted or empty and reject whitespace before the read", async () => {
  const usedDays: number[] = [];
  const load = (query: string) => {
    const params = new URL(`http://localhost/api/rates/history${query}`).searchParams;
    return getRateHistoryApiResult(params.get("corridor"), params.get("days"), {
      now: () => NOW,
      staleEvidenceStore: NO_STALE_STORE,
      readHistory: async (slug, { days }) => {
        usedDays.push(days);
        return {
          ok: true,
          corridor: { slug, sourceAsset: "USDC", sourceCountry: "US", destinationAsset: "BRL", destinationCountry: "BR" },
          evaluatedAt: NOW.toISOString(),
          windowDays: days,
          points: [],
        };
      },
    });
  };

  for (const query of [`?corridor=${CORRIDOR}`, `?corridor=${CORRIDOR}&days=`]) {
    const result = await load(query);
    assert.equal(result.status, 200);
    if (result.status === 200) assert.equal(result.body.windowDays, 30);
  }
  for (const query of [`?corridor=${CORRIDOR}&days=%20%20`, `?corridor=${CORRIDOR}&days=0`]) {
    const result = await load(query);
    assert.equal(result.status, 400);
    if (result.status === 400) assert.equal(result.body.error.code, "invalid_days");
  }
  const valid = await load(`?corridor=${CORRIDOR}&days=7`);
  assert.equal(valid.status, 200);
  if (valid.status === 200) assert.equal(valid.body.windowDays, 7);
  assert.deepEqual(usedDays, [30, 30, 7]);
});

test("history route rejects whitespace-only days through the public response contract", async () => {
  const result = await getHistory(new Request(`http://localhost/api/rates/history?corridor=${CORRIDOR}&days=%20%20`));
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.code, "invalid_days");
});

test("required corridor remains required for omitted and empty values on both evidence routes", async () => {
  for (const [path, get] of [["rates", getRates], ["rates/history", getHistory]] as const) {
    for (const query of ["", "?corridor="]) {
      const result = await get(new Request(`http://localhost/api/${path}${query}`));
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, "missing_corridor");
    }
    for (const query of ["?corridor=%20%20", "?corridor=bad--slug"]) {
      const result = await get(new Request(`http://localhost/api/${path}${query}`));
      assert.equal(result.status, 400);
      assert.equal((await result.json()).error.code, "invalid_corridor");
    }
  }
});
