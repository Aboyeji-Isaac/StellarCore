import assert from "node:assert/strict";
import test from "node:test";

import * as anchorDetailRoute from "@/app/api/anchors/[slug]/route";
import * as corridorDetailRoute from "@/app/api/corridors/[slug]/route";
import * as reputationDetailRoute from "@/app/api/reputation/[slug]/route";
import { getAnchorApiResult } from "@/lib/api/anchors";
import { getCorridorApiResult } from "@/lib/api/corridors";
import { getAnchorReputationApiResult } from "@/lib/api/reputation";
import type {
  AnchorDetailRecord,
  AnchorDirectoryRecord,
  AnchorDirectoryRepository,
} from "@/lib/api/anchorRepository";
import type { CorridorDetailRecord, CorridorDetailRepository } from "@/lib/api/corridorRepository";
import type { ReputationApiAnchorRecord, ReputationApiRepository } from "@/lib/api/reputationRepository";

const MALFORMED_FIXTURES = [
  "%",
  "%1",
  "%ZZ",
  "%AG",
  "%E0%A4%A",
  "%80",
  "%c0%af",
  "%ed%a0%80",
  "%00",
  "%0a",
  "%0d",
  "%1f",
  "%2e%2e",
  "%2f",
  "%2e%2e%2f%2e%2e",
  "%20",
  "%3cscript%3e",
] as const;

const SAMPLE_ANCHOR_DIRECTORY: AnchorDirectoryRecord = {
  slug: "zeam",
  name: "Zeam Finance",
  homeDomain: "zeam.example",
  status: "LIVE",
  seps: [1, 24, 38],
  corridorCount: 1,
};

const SAMPLE_ANCHOR_DETAIL: AnchorDetailRecord = {
  slug: "zeam",
  name: "Zeam Finance",
  homeDomain: "zeam.example",
  status: "LIVE",
  seps: [1, 24, 38],
  corridors: [],
};

const SAMPLE_CORRIDOR: CorridorDetailRecord = {
  slug: "usdc-us-brl-br",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "BRL",
  countryTo: "BR",
  anchors: [],
};

const SAMPLE_REPUTATION: ReputationApiAnchorRecord = {
  slug: "zeam",
  name: "Zeam Finance",
  reputationScore: {
    compositeScore: 85.5,
    scoreBand: "GREEN",
    fillRate7d: 0.99,
    fillRate30d: 0.98,
    fillRate90d: 0.97,
    settleP50Ms: 1200,
    settleP95Ms: 3400,
    slippageP50: 0.001,
    slippageP95: 0.003,
    sampleSize: 150,
    state: "OK",
    computedAt: new Date("2026-10-01T00:00:00Z"),
  },
};

function mockAnchorRepository(detail: AnchorDetailRecord | null): {
  repo: AnchorDirectoryRepository;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    repo: {
      findAll: async () => [SAMPLE_ANCHOR_DIRECTORY],
      findBySlug: async (slug: string) => {
        calls.push(slug);
        return detail && detail.slug === slug ? detail : null;
      },
    },
  };
}

function mockCorridorRepository(record: CorridorDetailRecord | null): {
  repo: CorridorDetailRepository;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    repo: {
      findBySlug: async (slug: string) => {
        calls.push(slug);
        return record && record.slug === slug ? record : null;
      },
    },
  };
}

function mockReputationRepository(record: ReputationApiAnchorRecord | null): {
  repo: ReputationApiRepository;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    repo: {
      findAll: async () => (record ? [record] : []),
      findBySlug: async (slug: string) => {
        calls.push(slug);
        return record && record.slug === slug ? record : null;
      },
    },
  };
}

test("public evidence routes safely reject malformed percent-encoded path segments", async () => {
  for (const fixture of MALFORMED_FIXTURES) {
    // 1. Anchor detail route
    const anchorRes = await anchorDetailRoute.GET(
      new Request(`http://localhost/api/anchors/${fixture}`),
      { params: Promise.resolve({ slug: fixture }) },
    );
    assert.equal(anchorRes.status, 400, `Expected 400 for anchor slug: ${fixture}`);
    assert.equal(anchorRes.headers.get("cache-control"), "no-store");
    const anchorBody = await anchorRes.json();
    assert.equal(anchorBody.error.code, "invalid_anchor_slug");
    assert.equal(anchorBody.error.message, "A valid anchor slug is required.");
    assert.equal(JSON.stringify(anchorBody).includes("URIError"), false);
    assert.equal(JSON.stringify(anchorBody).includes("stack"), false);

    // 2. Corridor detail route
    const corridorRes = await corridorDetailRoute.GET(
      new Request(`http://localhost/api/corridors/${fixture}`),
      { params: Promise.resolve({ slug: fixture }) },
    );
    assert.equal(corridorRes.status, 400, `Expected 400 for corridor slug: ${fixture}`);
    assert.equal(corridorRes.headers.get("cache-control"), "no-store");
    const corridorBody = await corridorRes.json();
    assert.equal(corridorBody.error.code, "invalid_corridor_slug");
    assert.equal(corridorBody.error.message, "A valid corridor slug is required.");
    assert.equal(JSON.stringify(corridorBody).includes("URIError"), false);
    assert.equal(JSON.stringify(corridorBody).includes("stack"), false);

    // 3. Reputation detail route
    const reputationRes = await reputationDetailRoute.GET(
      new Request(`http://localhost/api/reputation/${fixture}`),
      { params: Promise.resolve({ slug: fixture }) },
    );
    assert.equal(reputationRes.status, 400, `Expected 400 for reputation slug: ${fixture}`);
    assert.equal(reputationRes.headers.get("cache-control"), "no-store");
    const reputationBody = await reputationRes.json();
    assert.equal(reputationBody.error.code, "invalid_anchor_slug");
    assert.equal(reputationBody.error.message, "A valid anchor slug is required.");
    assert.equal(JSON.stringify(reputationBody).includes("URIError"), false);
    assert.equal(JSON.stringify(reputationBody).includes("stack"), false);
  }
});

test("malformed percent-encoded path segments never trigger underlying repository lookups", async () => {
  for (const fixture of MALFORMED_FIXTURES) {
    const anchorMock = mockAnchorRepository(SAMPLE_ANCHOR_DETAIL);
    const anchorResult = await getAnchorApiResult(fixture, { repository: anchorMock.repo });
    assert.equal(anchorResult.status, 400);
    assert.equal(anchorMock.calls.length, 0, `Anchor repository was called for ${fixture}`);

    const corridorMock = mockCorridorRepository(SAMPLE_CORRIDOR);
    const corridorResult = await getCorridorApiResult(fixture, { repository: corridorMock.repo });
    assert.equal(corridorResult.status, 400);
    assert.equal(corridorMock.calls.length, 0, `Corridor repository was called for ${fixture}`);

    const repMock = mockReputationRepository(SAMPLE_REPUTATION);
    const repResult = await getAnchorReputationApiResult(fixture, { repository: repMock.repo });
    assert.equal(repResult.status, 400);
    assert.equal(repMock.calls.length, 0, `Reputation repository was called for ${fixture}`);
  }
});

test("valid percent-encoded identifiers continue to work across all evidence routes", async () => {
  // Encoded "zeam" (%7a%65%61%6d)
  const encodedZeam = "%7a%65%61%6d";
  const anchorMock = mockAnchorRepository(SAMPLE_ANCHOR_DETAIL);
  const anchorResult = await getAnchorApiResult(encodedZeam, { repository: anchorMock.repo });
  assert.equal(anchorResult.status, 200);
  assert.equal(anchorMock.calls.length, 1);
  assert.equal(anchorMock.calls[0], "zeam");
  if (anchorResult.status === 200) {
    assert.equal(anchorResult.body.anchor.slug, "zeam");
    assert.equal(anchorResult.body.anchor.name, "Zeam Finance");
  }

  // Encoded "usdc-us-brl-br" (%75%73%64%63%2d%75%73%2d%62%72%6c%2d%62%72)
  const encodedCorridor = "%75%73%64%63%2d%75%73%2d%62%72%6c%2d%62%72";
  const corridorMock = mockCorridorRepository(SAMPLE_CORRIDOR);
  const corridorResult = await getCorridorApiResult(encodedCorridor, { repository: corridorMock.repo });
  assert.equal(corridorResult.status, 200);
  assert.equal(corridorMock.calls.length, 1);
  assert.equal(corridorMock.calls[0], "usdc-us-brl-br");
  if (corridorResult.status === 200) {
    assert.equal(corridorResult.body.corridor.slug, "usdc-us-brl-br");
  }

  // Encoded reputation "zeam"
  const repMock = mockReputationRepository(SAMPLE_REPUTATION);
  const repResult = await getAnchorReputationApiResult(encodedZeam, { repository: repMock.repo });
  assert.equal(repResult.status, 200);
  assert.equal(repMock.calls.length, 1);
  assert.equal(repMock.calls[0], "zeam");
  if (repResult.status === 200) {
    assert.equal(repResult.body.reputation.anchor.slug, "zeam");
  }
});

test("valid percent-encoded identifiers that do not exist return documented 404 response", async () => {
  const encodedNonexistent = "%6e%6f%6e%65%78%69%73%74%65%6e%74"; // "nonexistent"

  const anchorMock = mockAnchorRepository(null);
  const anchorResult = await getAnchorApiResult(encodedNonexistent, { repository: anchorMock.repo });
  assert.equal(anchorResult.status, 404);
  assert.equal(anchorResult.body.error.code, "anchor_not_found");
  assert.equal(anchorResult.body.error.message, "Anchor not found.");
  assert.equal(anchorMock.calls[0], "nonexistent");

  const corridorMock = mockCorridorRepository(null);
  const corridorResult = await getCorridorApiResult(encodedNonexistent, { repository: corridorMock.repo });
  assert.equal(corridorResult.status, 404);
  assert.equal(corridorResult.body.error.code, "corridor_not_found");
  assert.equal(corridorResult.body.error.message, "Corridor not found.");
  assert.equal(corridorMock.calls[0], "nonexistent");

  const repMock = mockReputationRepository(null);
  const repResult = await getAnchorReputationApiResult(encodedNonexistent, { repository: repMock.repo });
  assert.equal(repResult.status, 404);
  assert.equal(repResult.body.error.code, "anchor_not_found");
  assert.equal(repResult.body.error.message, "Anchor not found.");
  assert.equal(repMock.calls[0], "nonexistent");
});
