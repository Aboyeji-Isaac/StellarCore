import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { CorridorDetailView } from "@/app/corridors/[slug]/CorridorDetailView";
import type { CorridorApiResult } from "@/types/api/corridors";
import type { RatesApiResult } from "@/types/api/rates";
import type { RateHistoryApiResult } from "@/types/api/rateHistory";
import {
  exposeReactForClassicJsx,
  withTestAppRouter,
} from "../../support/dashboardContracts";

exposeReactForClassicJsx();

function getFixture(domain: "corridors" | "rates", name: string) {
  return JSON.parse(
    readFileSync(
      new URL(`../../../contracts/api/v1/fixtures/${domain}/${name}.json`, import.meta.url),
      "utf8",
    ),
  ).body;
}

const mockCorridorResult: CorridorApiResult = {
  status: 200,
  body: getFixture("corridors", "detail-success"),
};

const mockRatesResult: RatesApiResult = {
  status: 200,
  body: getFixture("rates", "healthy-success"),
};

function render(ratesResult: RatesApiResult, historyResult: RateHistoryApiResult): string {
  if (mockCorridorResult.status !== 200) throw new Error("Expected corridor fixture");
  return renderToStaticMarkup(withTestAppRouter(createElement(CorridorDetailView, {
    corridor: mockCorridorResult.body.corridor, ratesResult, historyResult,
  })));
}

const mockSuccessHistoryResult: RateHistoryApiResult = {
  status: 200,
  body: {
    corridor: {
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    },
    windowDays: 30,
    evaluatedAt: "2026-11-20T12:00:00Z",
    points: [
      {
        timestamp: "2026-11-19T00:00:00Z",
        medianRate: "5.40",
        state: "healthy",
        sourceCount: 2,
        freshSourceCount: 2,
        observations: ["cowrie", "zeam"].map((slug) => ({
          anchor: { slug, name: slug === "cowrie" ? "Cowrie" : "Zeam" },
          rate: "5.40",
          sourceAmount: "1",
          destinationAmount: "5.40",
          fee: "0",
          capturedAt: "2026-11-19T00:00:00Z",
        })),
      },
      {
        timestamp: "2026-11-20T00:00:00Z",
        medianRate: "5.42",
        state: "healthy",
        sourceCount: 2,
        freshSourceCount: 2,
        observations: ["cowrie", "zeam"].map((slug) => ({
          anchor: { slug, name: slug === "cowrie" ? "Cowrie" : "Zeam" },
          rate: "5.42",
          sourceAmount: "1",
          destinationAmount: "5.42",
          fee: "0",
          capturedAt: "2026-11-20T00:00:00Z",
        })),
      },
    ],
  },
};

const mockEmptyHistoryResult: RateHistoryApiResult = {
  status: 200,
  body: {
    corridor: {
      slug: "usdc-us-brl-br",
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    },
    windowDays: 30,
    evaluatedAt: "2026-11-20T12:00:00Z",
    points: [],
  },
};

const mock500HistoryResult: RateHistoryApiResult = {
  status: 500,
  body: {
    error: {
      code: "internal_error",
      message: "Database failure reading rate history",
    },
  },
};

const mock404HistoryResult: RateHistoryApiResult = {
  status: 404,
  body: {
    error: {
      code: "corridor_not_found",
      message: "Rate history not recorded for corridor",
    },
  },
};

test("CorridorPage: history status 200 renders the rate history chart and no failure state", () => {
  const html = render(mockRatesResult, mockSuccessHistoryResult);

  // Chart is rendered
  assert.match(html, /Historical rate chart/);
  assert.match(html, /data-testid="corridor-rate-history-section"/);
  assert.match(html, /data-testid="rate-history-displayed-window"/);

  // Failure state is NOT rendered
  assert.doesNotMatch(html, /data-testid="rate-history-failure-state"/);
});

test("CorridorPage: history error 500 renders a visible failure state without disappearing or breaking latest rates", () => {
  const html = render(mockRatesResult, mock500HistoryResult);

  // Latest rate panel still renders successfully
  assert.match(html, /Latest rate evidence/);
  assert.match(html, /5\.25/);
  assert.match(html, /2 of 2 required/);

  // Associated anchors still render
  assert.match(html, /Cowrie/);
  assert.match(html, /Zeam/);

  // Rate history section is visible and contains accessible error alert
  assert.match(html, /data-testid="corridor-rate-history-section"/);
  assert.match(html, /data-testid="rate-history-failure-state"/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /Database failure reading rate history/);
  assert.match(html, /Historical rate observations could not be loaded for this corridor/);
});

test("CorridorPage: history error 404 does not cause whole corridor page to 404", () => {
  const html = render(mockRatesResult, mock404HistoryResult);

  // Header, breadcrumb, and anchors are preserved
  assert.match(html, /USDC \(US\) → BRL \(BR\)/);
  assert.match(html, /data-testid="rate-history-failure-state"/);
  assert.doesNotMatch(html, /Rate history not recorded for corridor/);
  assert.match(html, /Historical rate observations could not be loaded for this corridor/);
});

test("CorridorPage: empty successful history remains distinct from failed request", () => {
  const html = render(mockRatesResult, mockEmptyHistoryResult);

  // Does NOT render failure state
  assert.doesNotMatch(html, /data-testid="rate-history-failure-state"/);

  // Renders the empty history notification inside the chart component
  assert.match(html, /No historical rate snapshots were returned for the/);
});

test("CorridorPage: rates failure is isolated from history success", () => {
  const mockFailedRates: RatesApiResult = {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Rates calculation service unavailable",
      },
    },
  };

  const html = render(mockFailedRates, mockSuccessHistoryResult);

  // Rates failure rendered
  assert.match(html, /data-evidence-state="unavailable"/);
  assert.match(html, /Rates calculation service unavailable/);

  // History chart still rendered successfully
  assert.match(html, /data-testid="corridor-rate-history-section"/);
  assert.match(html, /data-testid="rate-history-displayed-window"/);
  assert.doesNotMatch(html, /data-testid="rate-history-failure-state"/);
});
