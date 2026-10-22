import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RatePanelView } from "@/components/dashboard/RatePanel";
import { SectionError } from "@/components/dashboard/SectionStates";
import { dashboardFailureGuidance } from "@/lib/dashboard/failureGuidance";
import type { RatesApiResult } from "@/types/api/rates";

const REQUEST_ID = "9f1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";

function renderError(
  area: "anchors" | "corridors" | "rates" | "rate_history" | "reputation",
  code: string,
  message: string,
  requestId?: string,
): string {
  return renderToStaticMarkup(createElement(SectionError, {
    area,
    code,
    message,
    requestId,
  }));
}

function text(html: string, testId: string): string | null {
  return html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]*)<`))?.[1] ?? null;
}

test("each dashboard area is named in plain language and keeps the public message", () => {
  const cases = [
    ["anchors", "internal_error", "Unable to load anchors.", "Anchor directory unavailable"],
    ["corridors", "internal_error", "Unable to load corridors.", "Corridor directory unavailable"],
    ["rates", "internal_error", "Unable to read rates.", "Rate evidence unavailable"],
    ["rate_history", "internal_error", "Unable to read rate history.", "Rate history unavailable"],
    ["reputation", "internal_error", "Unable to load reputation.", "Anchor reputation unavailable"],
  ] as const;

  for (const [area, code, message, title] of cases) {
    const html = renderError(area, code, message);
    assert.equal(text(html, "section-error-title"), title);
    assert.equal(text(html, "section-error-message"), message);
    assert.match(html, /role="alert"/);
  }
});

test("retry guidance appears only for failures a reload can recover from", () => {
  for (const retryable of ["internal_error", "upstream_unavailable", "rate_limited"]) {
    const html = renderError("anchors", retryable, "Unable to load anchors.");
    assert.match(
      text(html, "section-error-guidance") ?? "",
      /reload|wait about a minute/i,
      `${retryable} should advertise a retry path`,
    );
    assert.equal(dashboardFailureGuidance("anchors", { code: retryable, message: "" }).retry, true);
  }

  for (const permanent of [
    "invalid_anchor_slug",
    "invalid_corridor_slug",
    "invalid_pagination",
    "invalid_days",
    "anchor_not_found",
    "corridor_not_found",
  ]) {
    const html = renderError("corridors", permanent, "A valid corridor slug is required.");
    const guidance = text(html, "section-error-guidance") ?? "";
    assert.doesNotMatch(guidance, /reload the page to retry/i, `${permanent} must not suggest a retry`);
    assert.equal(
      dashboardFailureGuidance("corridors", { code: permanent, message: "" }).retry,
      false,
    );
  }
});

test("representative API failures cannot render stack traces, credentials, or SQL", () => {
  const leaked = [
    "postgresql://admin:super-secret@private-db.internal/core",
    "SELECT * FROM \"RateSnapshot\" WHERE id = 1",
    "Error: connect ECONNREFUSED 10.0.0.5:5432",
    "    at query (/srv/app/lib/rates/latestRateRepository.ts:10:5)",
    "DATABASE_URL=postgres://user:pass@db.internal/core",
  ];

  for (const message of leaked) {
    const html = renderError("rates", "internal_error", message);
    for (const fragment of [
      "super-secret",
      "private-db.internal",
      "RateSnapshot",
      "ECONNREFUSED",
      "latestRateRepository.ts",
      "DATABASE_URL",
    ]) {
      assert.equal(html.includes(fragment), false, `${fragment} must not be rendered`);
    }
    assert.equal(text(html, "section-error-message"), "Unable to load rate evidence.");
  }
});

test("unknown codes fall back to a generic safe message and retry guidance", () => {
  const html = renderError(
    "reputation",
    "some_unreviewed_driver_error",
    "PrismaClientKnownRequestError: relation \"Anchor\" does not exist",
  );

  assert.equal(text(html, "section-error-title"), "Anchor reputation unavailable");
  assert.equal(text(html, "section-error-message"), "Unable to load anchor reputation.");
  assert.match(html, /data-error-code="unknown_error"/);
  assert.match(text(html, "section-error-guidance") ?? "", /reload the page to retry/i);
  assert.equal(html.includes("PrismaClientKnownRequestError"), false);
  assert.equal(html.includes("relation"), false);
});

test("a validated correlation reference is shown and a forged one is dropped", () => {
  const withReference = renderError(
    "anchors",
    "internal_error",
    "Unable to load anchors.",
    REQUEST_ID,
  );
  assert.equal(text(withReference, "section-error-reference"), `Reference: ${REQUEST_ID}`);

  const forged = renderError(
    "anchors",
    "internal_error",
    "Unable to load anchors.",
    "postgresql://admin:super-secret@private-db.internal/core",
  );
  assert.equal(text(forged, "section-error-reference"), null);
  assert.equal(forged.includes("super-secret"), false);

  const absent = renderError("anchors", "internal_error", "Unable to load anchors.");
  assert.equal(text(absent, "section-error-reference"), null);
});

test("the failed rate panel renders area guidance instead of a bare API message", () => {
  const result: RatesApiResult = {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Unable to read rates.",
        requestId: REQUEST_ID,
      },
    },
  };
  const html = renderToStaticMarkup(createElement(RatePanelView, { result }));

  assert.equal(text(html, "section-error-title"), "Rate evidence unavailable");
  assert.equal(text(html, "section-error-message"), "Unable to read rates.");
  assert.match(html, /data-testid="section-error-rates"/);
  assert.equal(text(html, "section-error-reference"), `Reference: ${REQUEST_ID}`);
  // A failed refresh must never publish a freshness indicator.
  assert.equal(html.includes("rate-evidence-freshness"), false);
});

test("guidance is frozen and carries the retry decision for callers", () => {
  const guidance = dashboardFailureGuidance("rates", {
    code: "rate_limited",
    message: "Too many requests. Please try again later.",
    requestId: REQUEST_ID,
  });
  assert.equal(Object.isFrozen(guidance), true);
  assert.equal(guidance.retry, true);
  assert.equal(guidance.reference, REQUEST_ID);
  assert.equal(guidance.areaLabel, "Rate evidence");
  assert.match(guidance.guidance, /wait about a minute/i);
});
