import assert from "node:assert/strict";
import test from "node:test";

import { GET as getCorridorsRoute } from "@/app/api/corridors/route";
import { GET as getAnchorsRoute } from "@/app/api/anchors/route";
import { GET as getHistoryRoute } from "@/app/api/rates/history/route";
import { GET as getRatesRoute } from "@/app/api/rates/route";
import { getAnchorsApiResult, getAnchorApiResult } from "@/lib/api/anchors";
import { getCorridorsApiResult, getCorridorApiResult } from "@/lib/api/corridors";
import { getRateHistoryApiResult } from "@/lib/api/rateHistory";
import { getRatesApiResult } from "@/lib/api/rates";
import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import { MAX_PAGE_LIMIT, readPaginationQuery } from "@/lib/api/pagination";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";
import type { AnchorDirectoryRepository } from "@/lib/api/anchorRepository";
import type { CorridorDetailRepository, CorridorDirectoryRepository } from "@/lib/api/corridorRepository";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const MAX_SLUG_LENGTH = 100;
/** The longest slug the public contract accepts. */
const MAX_VALID_SLUG = "a".repeat(MAX_SLUG_LENGTH);
const ONE_OVER_SLUG = "a".repeat(MAX_SLUG_LENGTH + 1);
/** Far beyond any documented limit; used to prove rejection happens early. */
const PATHOLOGICAL = "a".repeat(65_536);
const NO_STALE_STORE: StaleEvidenceStore = {
  read: async () => null,
  write: async () => {},
};

type RejectedResult = Readonly<{
  status: number;
  body: Readonly<{ error: Readonly<{ code: string; message: string }> }>;
}>;

function assertSafeRejection(
  result: RejectedResult,
  expectedCode: string,
  label: string,
): void {
  assert.equal(result.status, 400, `${label} status`);
  assert.equal(result.body.error.code, expectedCode, `${label} code`);
  assert.deepEqual(Object.keys(result.body).sort(), ["error"], `${label} envelope`);
  assert.deepEqual(
    Object.keys(result.body.error).sort(),
    ["code", "message"],
    `${label} error keys`,
  );
  const serialized = JSON.stringify(result.body);
  assert.ok(
    serialized.length < 160,
    `${label} error payload must stay bounded, was ${serialized.length} bytes`,
  );
  assert.equal(serialized.includes("aaaa"), false, `${label} must not echo input`);
  assert.equal(serialized.includes(PATHOLOGICAL.slice(0, 32)), false);
}

/**
 * An accepted repository read is the signal that a value passed validation.
 * These stubs fail the test if validation lets an oversized value through.
 */
function anchorRepository(onRead: () => void): AnchorDirectoryRepository {
  return {
    findAll: async () => {
      onRead();
      return [];
    },
    findBySlug: async () => {
      onRead();
      return null;
    },
  };
}

function corridorDirectoryRepository(onRead: () => void): CorridorDirectoryRepository {
  return {
    findAll: async () => {
      onRead();
      return [];
    },
  };
}

function corridorDetailRepository(onRead: () => void): CorridorDetailRepository {
  return {
    findBySlug: async () => {
      onRead();
      return null;
    },
  };
}

test("the documented corridor slug limit is accepted and anything longer is rejected before the read", async () => {
  let reads = 0;
  const accepted = await getRatesApiResult(MAX_VALID_SLUG, {
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    readLatestRate: async (slug) => {
      reads++;
      assert.equal(slug, MAX_VALID_SLUG);
      return {
        ok: true,
        corridor: {
          slug,
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
        },
        evaluatedAt: NOW.toISOString(),
        state: "insufficient_fresh_sources",
        median: null,
        totalIndependentSources: 0,
        freshSourceCount: 0,
        observations: [],
        exclusions: [],
      };
    },
  });
  assert.equal(accepted.status, 200);
  assert.equal(reads, 1, "a 100-character corridor slug must reach the read");

  for (const value of [ONE_OVER_SLUG, PATHOLOGICAL]) {
    const rejected = await getRatesApiResult(value, {
      now: () => NOW,
      staleEvidenceStore: NO_STALE_STORE,
      readLatestRate: async () => {
        reads++;
        throw new Error("oversized corridor must not be read");
      },
    });
    assertSafeRejection(rejected as RejectedResult, "invalid_corridor", `corridor length ${value.length}`);
  }
  assert.equal(reads, 1);
});

test("rate history enforces the corridor and days boundaries before any read", async () => {
  const used: Array<{ slug: string; days: number }> = [];
  const load = (corridor: string, days: string) =>
    getRateHistoryApiResult(corridor, days, {
      now: () => NOW,
      staleEvidenceStore: NO_STALE_STORE,
      readHistory: async (slug, options) => {
        used.push({ slug, days: options.days });
        return {
          ok: true,
          corridor: {
            slug,
            sourceAsset: "USDC",
            sourceCountry: "US",
            destinationAsset: "BRL",
            destinationCountry: "BR",
          },
          evaluatedAt: NOW.toISOString(),
          windowDays: options.days,
          points: [],
        };
      },
    });

  const maxWindow = await load(MAX_VALID_SLUG, "365");
  assert.equal(maxWindow.status, 200);
  assert.deepEqual(used, [{ slug: MAX_VALID_SLUG, days: 365 }]);

  for (const days of ["366", "9".repeat(4_096), "99999999999999999999"]) {
    const rejected = await load(MAX_VALID_SLUG, days);
    assertSafeRejection(rejected as RejectedResult, "invalid_days", `days length ${days.length}`);
  }
  for (const corridor of [ONE_OVER_SLUG, PATHOLOGICAL]) {
    const rejected = await load(corridor, "30");
    assertSafeRejection(rejected as RejectedResult, "invalid_corridor", `corridor length ${corridor.length}`);
  }
  assert.equal(used.length, 1, "rejected values must not reach the read model");
});

test("directory pagination enforces its documented limit and rejects oversized integers", async () => {
  for (const path of ["anchors", "corridors"] as const) {
    let reads = 0;
    const load = (query: string) => {
      const pagination = readPaginationQuery(
        new URL(`http://localhost/api/${path}${query}`).searchParams,
      );
      return path === "anchors"
        ? getAnchorsApiResult({ repository: anchorRepository(() => { reads++; }) }, pagination)
        : getCorridorsApiResult({ repository: corridorDirectoryRepository(() => { reads++; }) }, pagination);
    };

    const accepted = await load(`?limit=${MAX_PAGE_LIMIT}&offset=0`);
    assert.equal(accepted.status, 200, `${path} documented maximum limit`);
    assert.equal(reads, 1);

    for (const query of [
      `?limit=${MAX_PAGE_LIMIT + 1}`,
      `?limit=${"9".repeat(4_096)}`,
      `?offset=${"9".repeat(4_096)}`,
      `?offset=${"9".repeat(20)}`,
      `?limit=1&offset=${PATHOLOGICAL}`,
    ]) {
      const rejected = await load(query);
      assertSafeRejection(
        rejected as RejectedResult,
        "invalid_pagination",
        `${path}${query.slice(0, 24)} (${query.length} chars)`,
      );
    }
    assert.equal(reads, 1, `${path} rejected pagination must not broaden a read`);
  }
});

test("oversized query values are rejected through the public routes with bounded payloads", async () => {
  const cases = [
    {
      label: "rates corridor",
      response: await getRatesRoute(
        new Request(`http://localhost/api/rates?corridor=${PATHOLOGICAL}`),
      ),
      code: "invalid_corridor",
    },
    {
      label: "history corridor",
      response: await getHistoryRoute(
        new Request(`http://localhost/api/rates/history?corridor=${PATHOLOGICAL}&days=30`),
      ),
      code: "invalid_corridor",
    },
    {
      label: "history days",
      response: await getHistoryRoute(
        new Request(
          `http://localhost/api/rates/history?corridor=${MAX_VALID_SLUG}&days=${"9".repeat(4_096)}`,
        ),
      ),
      code: "invalid_days",
    },
    {
      label: "anchors limit",
      response: await getAnchorsRoute(
        new Request(`http://localhost/api/anchors?limit=${"9".repeat(4_096)}`),
      ),
      code: "invalid_pagination",
    },
    {
      label: "corridors offset",
      response: await getCorridorsRoute(
        new Request(`http://localhost/api/corridors?offset=${"9".repeat(4_096)}`),
      ),
      code: "invalid_pagination",
    },
  ] as const;

  for (const { label, response, code } of cases) {
    assert.equal(response.status, 400, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    const body = await response.json();
    assert.equal(body.error.code, code, label);
    assert.equal(JSON.stringify(body).length < 160, true, `${label} payload must stay bounded`);
    assert.equal(JSON.stringify(body).includes("aaaa"), false, `${label} must not echo input`);
  }
});

test("detail slugs accept the documented maximum and reject oversized values before the read", async () => {
  let reads = 0;

  const rejections: ReadonlyArray<Readonly<{ result: RejectedResult; code: string }>> = [
    {
      result: await getAnchorApiResult(ONE_OVER_SLUG, { repository: anchorRepository(() => { reads++; }) }) as RejectedResult,
      code: "invalid_anchor_slug",
    },
    {
      result: await getAnchorApiResult(PATHOLOGICAL, { repository: anchorRepository(() => { reads++; }) }) as RejectedResult,
      code: "invalid_anchor_slug",
    },
    {
      result: await getCorridorApiResult(ONE_OVER_SLUG, { repository: corridorDetailRepository(() => { reads++; }) }) as RejectedResult,
      code: "invalid_corridor_slug",
    },
    {
      result: await getCorridorApiResult(PATHOLOGICAL, { repository: corridorDetailRepository(() => { reads++; }) }) as RejectedResult,
      code: "invalid_corridor_slug",
    },
    {
      result: await getAnchorReputationApiResult(ONE_OVER_SLUG) as RejectedResult,
      code: "invalid_anchor_slug",
    },
    {
      result: await getAnchorReputationApiResult(PATHOLOGICAL) as RejectedResult,
      code: "invalid_anchor_slug",
    },
  ];

  for (const { result, code } of rejections) {
    assertSafeRejection(result, code, "detail slug");
  }
  assert.equal(reads, 0, "oversized detail slugs must not reach a repository");

  const acceptedAnchor = await getAnchorApiResult(MAX_VALID_SLUG, {
    repository: anchorRepository(() => { reads++; }),
  });
  const acceptedCorridor = await getCorridorApiResult(MAX_VALID_SLUG, {
    repository: corridorDetailRepository(() => { reads++; }),
  });
  assert.equal(acceptedAnchor.status, 404);
  assert.equal(acceptedCorridor.status, 404);
  assert.equal(reads, 2, "a 100-character slug must still be read");
});

test("normal valid query values remain accepted at every evidence endpoint", async () => {
  const rates = await getRatesApiResult("usdc-us-brl-br", {
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    readLatestRate: async (slug) => ({
      ok: true,
      corridor: {
        slug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      },
      evaluatedAt: NOW.toISOString(),
      state: "insufficient_fresh_sources",
      median: null,
      totalIndependentSources: 0,
      freshSourceCount: 0,
      observations: [],
      exclusions: [],
    }),
  });
  assert.equal(rates.status, 200);

  const history = await getRateHistoryApiResult("usdc-us-brl-br", "7", {
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    readHistory: async (slug, { days }) => ({
      ok: true,
      corridor: {
        slug,
        sourceAsset: "USDC",
        sourceCountry: "US",
        destinationAsset: "BRL",
        destinationCountry: "BR",
      },
      evaluatedAt: NOW.toISOString(),
      windowDays: days,
      points: [],
    }),
  });
  assert.equal(history.status, 200);

  const anchors = await getAnchorsApiResult(
    { repository: anchorRepository(() => {}) },
    readPaginationQuery(new URL("http://localhost/api/anchors?limit=2&offset=1").searchParams),
  );
  const corridors = await getCorridorsApiResult(
    { repository: corridorDirectoryRepository(() => {}) },
    readPaginationQuery(new URL("http://localhost/api/corridors?limit=2").searchParams),
  );
  assert.equal(anchors.status, 200);
  assert.equal(corridors.status, 200);
});
