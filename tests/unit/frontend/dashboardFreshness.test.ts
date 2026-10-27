import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RatePanelView } from "@/components/dashboard/RatePanel";
import type { RatesApiResult, PublicRateObservation } from "@/types/api/rates";

const OLD = "2026-08-28T11:58:00.000Z";
const NEW = "2026-08-28T11:59:00.000Z";

function observation(capturedAt: string): PublicRateObservation {
  return {
    anchor: { slug: "zeam", name: "Zeam" },
    rate: "1.25",
    sourceAmount: "100",
    destinationAmount: "125",
    fee: "0",
    capturedAt,
    freshness: { state: "fresh", ageMs: 1_000 },
    eligibleForMedian: false,
  };
}

function response(evaluatedAt: string, capturedAt?: string): RatesApiResult {
  return {
    status: 200,
    body: {
      corridor: {
        slug: "usdc-us-brl-br",
        sourceAsset: "USDC",
        sourceCountry: "US",
        destinationAsset: "BRL",
        destinationCountry: "BR",
      },
      evaluatedAt,
      state: "insufficient_fresh_sources",
      medianRate: null,
      sourceCount: capturedAt ? 1 : 0,
      freshSourceCount: capturedAt ? 1 : 0,
      reviewedCandidateConfiguration: { candidateCount: 1, uniqueAnchorCount: 1 },
      medianRequirement: { minimumFreshIndependentSources: 2 },
      observations: capturedAt ? [observation(capturedAt)] : [],
    },
  };
}

function freshness(result: RatesApiResult): string | null {
  const html = renderToStaticMarkup(createElement(RatePanelView, { result }));
  return html.match(/data-testid="rate-evidence-freshness"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;
}

test("manual rerenders advance displayed evidence freshness only with a newer valid capture time", () => {
  const first = freshness(response("2026-08-28T12:00:00.000Z", OLD));
  const unchanged = freshness(response("2026-08-28T12:01:00.000Z", OLD));
  const updated = freshness(response("2026-08-28T12:02:00.000Z", NEW));
  const repeated = freshness(response("2026-08-28T12:03:00.000Z", NEW));

  assert.equal(first, `Latest observation captured ${new Date(OLD).toLocaleString()}`);
  assert.equal(unchanged, first);
  assert.equal(updated, `Latest observation captured ${new Date(NEW).toLocaleString()}`);
  assert.equal(repeated, updated);
});

test("failed refresh cannot publish a newer freshness indicator", () => {
  const before = freshness(response("2026-08-28T12:00:00.000Z", OLD));
  const failure: RatesApiResult = {
    status: 500,
    body: { error: { code: "internal_error", message: "Unable to read rates." } },
  };
  assert.equal(freshness(failure), null);
  assert.equal(freshness(response("2026-08-28T12:02:00.000Z", OLD)), before);
});

test("empty or invalid evidence timestamps use the documented fallback", () => {
  const empty = freshness(response("2026-08-28T12:00:00.000Z"));
  const invalid = freshness(response("2026-08-28T12:01:00.000Z", "invalid"));
  assert.equal(empty, "Freshness unavailable — no valid observation time");
  assert.equal(invalid, empty);
  const invalidHtml = renderToStaticMarkup(createElement(RatePanelView, {
    result: response("2026-08-28T12:01:00.000Z", "invalid"),
  }));
  assert.match(invalidHtml, />Unavailable<\/td>/);
  assert.doesNotMatch(invalidHtml, /Invalid Date/);
});
