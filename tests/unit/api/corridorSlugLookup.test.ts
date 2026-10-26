import assert from "node:assert/strict";
import test from "node:test";

import { GET as getCorridorRoute } from "@/app/api/corridors/[slug]/route";
import { CORRIDOR_REGISTRY } from "@/constants/corridors";
import {
  getCorridorApiResult,
  isValidCorridorSlug,
} from "@/lib/api/corridors";
import {
  PRISMA_CORRIDOR_DIRECTORY_REPOSITORY,
  type CorridorDetailRecord,
  type CorridorDetailRepository,
} from "@/lib/api/corridorRepository";

const CANONICAL_SLUGS = Object.freeze([
  "usdc-us-usd-us",
  "ngnt-ng-ngn-ng",
  "usdc-us-brl-br",
  "corridor",
  "usdc2-us-usd3-us",
]);

/**
 * Every entry below is either ambiguous with a canonical slug (case, spacing,
 * encoding, lookalike punctuation) or violates the stable identifier grammar.
 * None of them may be normalized, coerced, or forwarded to a repository.
 */
const AMBIGUOUS_OR_MALFORMED_SLUGS = Object.freeze([
  "",
  "USDC-US-USD-US",
  "Usdc-us-usd-us",
  "USDC-us-usd-us",
  " usdc-us-usd-us",
  "usdc-us-usd-us ",
  "usdc usd usd us",
  "usdc-us-usd-us\t",
  "usdc-us-usd-us\n",
  "usdc-us-usd-us\r\n",
  "usdc-us-usd-us/",
  "/usdc-us-usd-us",
  "-usdc-us-usd-us",
  "usdc-us-usd-us-",
  "usdc--us-usd-us",
  "usdc_us_usd_us",
  "usdc.us.usd.us",
  "usdc-us-usd-us?x=1",
  "usdc-us-usd-us#brl",
  "usdc-us-usd-us+brl",
  "usdc-us-usd-us%00",
  "usdc-us-usd-us%2F",
  "usdc\u2011us\u2011usd\u2011us",
  "ｕｓｄｃ-ｕｓ-ｕｓｄ-ｕｓ",
  "usdc-us-usd-usé",
  "usdc-us-usd-us\u0000",
  "../corridor",
  `${"a".repeat(99)}-b`,
]);

const INVALID_CORRIDOR_SLUG_BODY = Object.freeze({
  error: Object.freeze({
    code: "invalid_corridor_slug" as const,
    message: "A valid corridor slug is required.",
  }),
});

const CORRIDOR_NOT_FOUND_BODY = Object.freeze({
  error: Object.freeze({
    code: "corridor_not_found" as const,
    message: "Corridor not found.",
  }),
});

test("only canonical lowercase hyphen-separated slugs pass validation", () => {
  for (const slug of CANONICAL_SLUGS) {
    assert.equal(isValidCorridorSlug(slug), true, slug);
  }

  // 100 characters is the inclusive upper bound for a single identifier.
  const maximumLengthSlug = `${"a".repeat(98)}-b`;
  assert.equal(maximumLengthSlug.length, 100);
  assert.equal(isValidCorridorSlug(maximumLengthSlug), true, maximumLengthSlug);

  for (const slug of AMBIGUOUS_OR_MALFORMED_SLUGS) {
    assert.equal(isValidCorridorSlug(slug), false, JSON.stringify(slug));
  }
});

test("validation is stable across repeated calls and never coerces case", () => {
  for (const slug of CANONICAL_SLUGS) {
    assert.equal(isValidCorridorSlug(slug), isValidCorridorSlug(slug), slug);
    // Case variants must not alias the canonical identifier.
    assert.equal(isValidCorridorSlug(slug.toUpperCase()), false, slug);
    assert.equal(isValidCorridorSlug(` ${slug}`), false, slug);
    assert.equal(isValidCorridorSlug(`${slug} `), false, slug);
  }
});

test("malformed and ambiguous slugs fail with 400 before repository access", async () => {
  for (const slug of AMBIGUOUS_OR_MALFORMED_SLUGS) {
    const calls: string[] = [];
    const result = await getCorridorApiResult(slug, {
      repository: recordingRepository([], calls),
    });

    assert.deepEqual(
      result,
      { status: 400, body: INVALID_CORRIDOR_SLUG_BODY },
      JSON.stringify(slug),
    );
    assert.deepEqual(calls, [], JSON.stringify(slug));
  }
});

test("percent-decoded canonical slugs resolve to exactly the decoded slug", async () => {
  const encoded = "usdc%2Dus%2Dusd%2Dus";
  const decoded = decodeURIComponent(encoded);

  assert.equal(decoded, "usdc-us-usd-us");
  assert.equal(isValidCorridorSlug(decodeURIComponent(encoded)), true);

  const calls: string[] = [];
  const record = corridorDetail(decoded);
  const result = await getCorridorApiResult(decoded, {
    repository: recordingRepository([record], calls),
  });

  assert.equal(result.status, 200);
  if (result.status !== 200) return;
  assert.equal(result.body.corridor.slug, decoded);
  assert.deepEqual(calls, [decoded]);
});

test("percent-encoded case variants are rejected instead of normalized", async () => {
  const decoded = decodeURIComponent("%55SDC-US-USD-US");

  assert.equal(decoded, "USDC-US-USD-US");
  assert.equal(isValidCorridorSlug(decoded), false);

  const calls: string[] = [];
  const result = await getCorridorApiResult(decoded, {
    repository: recordingRepository([corridorDetail("usdc-us-usd-us")], calls),
  });

  assert.deepEqual(result, {
    status: 400,
    body: INVALID_CORRIDOR_SLUG_BODY,
  });
  assert.deepEqual(calls, []);
});

test("route rejects decoded malformed params with the contract 400 and no-store", async () => {
  for (const slug of [
    "USDC-US-USD-US",
    "usdc-us-usd-us/",
    "usdc--us-usd-us",
    "usdc_us_usd_us",
  ]) {
    const rawParam = encodeURIComponent(slug);
    const response = await getCorridorRoute(
      new Request(`http://localhost/api/corridors/${rawParam}`),
      { params: Promise.resolve({ slug: decodeURIComponent(rawParam) }) },
    );

    assert.equal(response.status, 400, slug);
    assert.deepEqual(await response.json(), INVALID_CORRIDOR_SLUG_BODY, slug);
    assert.equal(response.headers.get("cache-control"), "no-store", slug);
  }
});

test("every reviewed registry corridor slug remains compatible", async () => {
  for (const entry of CORRIDOR_REGISTRY) {
    assert.equal(isValidCorridorSlug(entry.slug), true, entry.slug);
    // Registry slugs must stay the canonical lowercase form used by the
    // configuration audit, otherwise lookups and the audit disagree.
    assert.equal(
      entry.slug,
      [entry.assetCodeFrom, entry.countryFrom, entry.assetCodeTo, entry.countryTo]
        .map((value) => value.toLowerCase())
        .join("-"),
      entry.slug,
    );

    const calls: string[] = [];
    const record = corridorDetail(entry.slug, [
      entry.assetCodeFrom,
      entry.countryFrom,
      entry.assetCodeTo,
      entry.countryTo,
    ]);
    const result = await getCorridorApiResult(entry.slug, {
      repository: recordingRepository([record], calls),
    });

    assert.equal(result.status, 200, entry.slug);
    if (result.status !== 200) continue;
    assert.equal(result.body.corridor.slug, entry.slug);
    assert.equal(result.body.corridor.sourceAsset, entry.assetCodeFrom);
    assert.equal(result.body.corridor.destinationCountry, entry.countryTo);
    assert.deepEqual(calls, [entry.slug]);
  }
});

test("near-collision slugs resolve only their own record and never a sibling", async () => {
  const slugs = Object.freeze([
    "usdc-us-usd-us",
    "usdc-us-usd-us2",
    "usdc-us-usd-us-x",
    "usdc-us-usd-u",
    "usdc-us-usd-usa",
    "xusdc-us-usd-us",
    "usdc-us-usd-us-us",
  ]);
  const records = Object.freeze(slugs.map((slug) => corridorDetail(slug)));

  for (const slug of slugs) {
    const calls: string[] = [];
    const result = await getCorridorApiResult(slug, {
      repository: recordingRepository(records, calls),
    });

    assert.equal(result.status, 200, slug);
    if (result.status !== 200) continue;
    assert.equal(result.body.corridor.slug, slug);
    // Exactly one exact-match lookup: no prefix, suffix, or case fallback.
    assert.deepEqual(calls, [slug], slug);
  }

  const calls: string[] = [];
  const missing = await getCorridorApiResult("usdc-us-usd-ub", {
    repository: recordingRepository(records, calls),
  });

  assert.deepEqual(missing, { status: 404, body: CORRIDOR_NOT_FOUND_BODY });
  assert.deepEqual(calls, ["usdc-us-usd-ub"]);
  const serialized = JSON.stringify(missing);
  for (const slug of slugs) {
    assert.equal(serialized.includes(slug), false, slug);
  }
});

test("repeated canonical lookups are deterministic and issue one exact query", async () => {
  const record = corridorDetail("usdc-us-usd-us");
  const calls: string[] = [];
  const repository = recordingRepository([record], calls);

  const first = await getCorridorApiResult("usdc-us-usd-us", { repository });
  const second = await getCorridorApiResult("usdc-us-usd-us", { repository });

  assert.deepEqual(first, second);
  assert.equal(first.status, 200);
  assert.deepEqual(calls, ["usdc-us-usd-us", "usdc-us-usd-us"]);
});

test("repository guard rejects non-canonical slugs before any database import", async () => {
  for (const slug of [
    "USDC-US-USD-US",
    " usdc-us-usd-us",
    "usdc--us-usd-us",
    "usdc_us_usd_us",
    "usdc-us-usd-us%00",
  ]) {
    await assert.rejects(
      PRISMA_CORRIDOR_DIRECTORY_REPOSITORY.findBySlug(slug),
      /Invalid corridor slug/,
      slug,
    );
  }
});

function recordingRepository(
  records: readonly CorridorDetailRecord[],
  calls: string[],
): CorridorDetailRepository {
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  return Object.freeze({
    findBySlug: async (slug: string) => {
      calls.push(slug);
      return bySlug.get(slug) ?? null;
    },
  });
}

function corridorDetail(
  slug: string,
  tuple: readonly [string, string, string, string] = ["USDC", "US", "USD", "US"],
): CorridorDetailRecord {
  const [sourceAsset, sourceCountry, destinationAsset, destinationCountry] = tuple;
  return Object.freeze({
    slug,
    assetCodeFrom: sourceAsset,
    countryFrom: sourceCountry,
    assetCodeTo: destinationAsset,
    countryTo: destinationCountry,
    anchors: Object.freeze([]),
  });
}
