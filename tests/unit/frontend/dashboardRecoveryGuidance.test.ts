import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RatePanelView } from "@/components/dashboard/RatePanel";
import { SectionError } from "@/components/dashboard/SectionStates";
import {
  dashboardFailureGuidance,
  safeFailureMessage,
  type DashboardFailureArea,
} from "@/lib/dashboard/failureGuidance";
import type { RatesApiResult } from "@/types/api/rates";

const AREAS: readonly DashboardFailureArea[] = [
  "anchors",
  "corridors",
  "rates",
  "reputation",
  "rate-history",
];

const REQUEST_ID = "5cf4e241-a328-4881-a1e3-8b319d8a7320";

function rateError(
  code: string,
  message: string,
  requestId?: string,
): RatesApiResult {
  return {
    status: 500,
    body: { error: { code: code as "internal_error", message, requestId } },
  };
}

test("every dashboard area is named in plain language", () => {
  const titles = new Set<string>();
  for (const area of AREAS) {
    const guidance = dashboardFailureGuidance(area, {
      code: "internal_error",
      message: "Unable to load.",
    });
    assert.equal(guidance.area, area);
    assert.match(guidance.title, / unavailable$/);
    assert.match(guidance.areaLabel, /\w/);
    assert.equal(guidance.title.includes("_"), false);
    titles.add(guidance.title);
  }
  assert.equal(titles.size, AREAS.length, "each area needs its own heading");
});

test("retry guidance appears only where a reload can plausibly help", () => {
  for (const code of ["internal_error", "upstream_unavailable"]) {
    const guidance = dashboardFailureGuidance("rates", { code, message: "Failed." });
    assert.equal(guidance.retry, true, `${code} is transient`);
    assert.match(guidance.guidance, /Reload the page to retry/);
  }

  for (const code of [
    "missing_corridor",
    "invalid_corridor",
    "invalid_days",
    "invalid_corridor_slug",
    "invalid_anchor_slug",
    "anchor_not_found",
    "corridor_not_found",
    "invalid_pagination",
  ]) {
    const guidance = dashboardFailureGuidance("rates", { code, message: "Invalid request." });
    assert.equal(guidance.retry, false, `${code} fails identically on every attempt`);
    assert.match(guidance.guidance, /Reloading will not change this result/);
    assert.doesNotMatch(guidance.guidance, /Reload the page to retry/);
  }
});

test("rate limiting gets wait-then-reload copy instead of a generic retry", () => {
  const guidance = dashboardFailureGuidance("anchors", {
    code: "rate_limited",
    message: "Too many requests. Please try again later.",
  });
  assert.equal(guidance.retry, true);
  assert.match(guidance.guidance, /Wait a minute, then reload the page/);
});

test("unknown or missing codes are normalised and never rendered verbatim", () => {
  for (const code of ["SOME_DRIVER_FAILURE", "", undefined]) {
    const guidance = dashboardFailureGuidance("corridors", {
      code,
      message: "Failed.",
    });
    assert.equal(guidance.code, "unknown_error");
    assert.equal(guidance.retry, true);
    assert.match(guidance.guidance, /Reload the page to try again/);
  }
});

test("internal diagnostics are replaced with an area message", () => {
  const unsafeMessages = [
    "Error: connect ECONNREFUSED 10.0.0.5:5432\n    at PrismaClient._request (file:///app/lib/db.ts:42:11)",
    "postgresql://admin:super-secret@private-db.internal/core",
    "select id, secret from anchors where slug = 'zeam'",
    "PrismaClientKnownRequestError: connection pool exhausted",
    'password="hunter2"',
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    "boom\nline two",
    "<script>alert(1)</script>",
    "x".repeat(400),
  ];

  for (const message of unsafeMessages) {
    const rendered = safeFailureMessage("rates", message);
    assert.equal(rendered, "Unable to load rate evidence.", message);
  }

  // Legitimate public API copy is preserved verbatim.
  assert.equal(safeFailureMessage("rates", "Unable to read rates."), "Unable to read rates.");
  assert.equal(
    safeFailureMessage("anchors", "Unable to load anchors."),
    "Unable to load anchors.",
  );
  // Non-strings never reach the DOM.
  assert.equal(safeFailureMessage("reputation", undefined), "Unable to load reputation evidence.");
  assert.equal(safeFailureMessage("reputation", 500), "Unable to load reputation evidence.");
});

test("only a valid correlation id becomes a visible reference", () => {
  const valid = dashboardFailureGuidance("rates", {
    code: "internal_error",
    message: "Unable to read rates.",
    requestId: REQUEST_ID,
  });
  assert.equal(valid.reference, REQUEST_ID);

  for (const requestId of [
    undefined,
    "short",
    "postgresql://admin:secret@private-db.internal/core",
    "line\nbreak",
    "a".repeat(65),
  ]) {
    const guidance = dashboardFailureGuidance("rates", {
      code: "internal_error",
      message: "Unable to read rates.",
      requestId,
    });
    assert.equal(guidance.reference, null);
  }
});

test("a failed rate panel renders the area, recovery steps, and reference", () => {
  const html = renderToStaticMarkup(
    createElement(RatePanelView, {
      result: rateError("internal_error", "Unable to read rates.", REQUEST_ID),
    }),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /data-testid="section-error-rates"/);
  assert.match(html, /data-error-code="internal_error"/);
  assert.match(html, /Rate evidence unavailable/);
  assert.match(html, /Unable to read rates\./);
  assert.match(html, /Reload the page to retry/);
  assert.match(html, new RegExp(`Reference: ${REQUEST_ID}`));
  // The failed panel publishes no freshness or median evidence.
  assert.doesNotMatch(html, /data-testid="rate-evidence-freshness"/);
  assert.doesNotMatch(html, /Median rate/);
});

test("a terminal failure tells the reader that reloading will not help", () => {
  const html = renderToStaticMarkup(
    createElement(RatePanelView, {
      result: {
        status: 404,
        body: { error: { code: "corridor_not_found", message: "Corridor not found." } },
      },
    }),
  );

  assert.match(html, /Rate evidence unavailable/);
  assert.match(html, /Corridor not found\./);
  assert.match(html, /Reloading will not change this result/);
  assert.doesNotMatch(html, /section-error-reference/);
});

test("SectionError without an area keeps the original single-message rendering", () => {
  const html = renderToStaticMarkup(
    createElement(SectionError, { message: "Internal server error" }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /Internal server error/);
  assert.doesNotMatch(html, /section-error-title/);
});

test("the client rate-history chart renders safe guidance instead of raw failure text", () => {
  const source = readFileSync(
    new URL("../../../components/corridors/CorridorRateHistoryChart.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /area="rate-history"/);
  assert.match(source, /readPublicErrorBody/);
  assert.match(source, /<SectionError/);
  // No direct rendering of a caught error object.
  assert.doesNotMatch(source, /\{error\}/);
  assert.doesNotMatch(source, /errorData\?\.error\?\.message/);
});
