import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { exposeReactForClassicJsx } from "../../support/dashboardContracts";
import { ReputationSectionView } from "@/components/dashboard/ReputationSection";

exposeReactForClassicJsx();

test("reputation card has anchor detail link", () => {
  const result = {
    status: 200,
    body: {
      reputation: [
        {
          anchor: { slug: "usdc-us-brl-br", name: "USD Coin", homeDomain: "usdc.example" },
          state: "established",
          score: 95,
          scoreBand: "green",
          evidence: { outcomeCount: 120 },
          metrics: {
            fillRate7d: 98.5,
            fillRate30d: 97.2,
            fillRate90d: 96.8,
            settleP50Ms: 1200,
            settleP95Ms: 3500,
            slippageP50: 0.5,
          },
          computedAt: "2024-01-15T10:30:00Z",
        },
      ],
      count: 1,
    },
  } as const;

  const markup = renderToStaticMarkup(ReputationSectionView({ result }));
  // The anchor name should be wrapped in a Link to /anchors/[slug]
  assert.match(markup, /href="\/anchors\/usdc-us-brl-br"/);
  assert.match(markup, /USD Coin/);
  // Link should be focus-visible stylable
  assert.match(markup, /focus-visible:outline/);
  assert.match(markup, /rel="noopener noreferrer"/);
});

test("reputation card link works for insufficient evidence state", () => {
  const result = {
    status: 200,
    body: {
      reputation: [
        {
          anchor: { slug: "usdc-us-brl-br", name: "USD Coin", homeDomain: "usdc.example" },
          state: "insufficient_evidence",
          score: null,
          evidence: null,
        },
      ],
      count: 1,
    },
  } as const;

  const markup = renderToStaticMarkup(ReputationSectionView({ result }));
  assert.match(markup, /href="\/anchors\/usdc-us-brl-br"/);
  assert.match(markup, /Insufficient evidence/);
});

test("reputation card link works for not evaluated state", () => {
  const result = {
    status: 200,
    body: {
      reputation: [
        {
          anchor: { slug: "eur-usd-ca-br", name: "Euro", homeDomain: "eur.example" },
          state: "not_evaluated",
          score: null,
        },
      ],
      count: 1,
    },
  } as const;

  const markup = renderToStaticMarkup(ReputationSectionView({ result }));
  assert.match(markup, /href="\/anchors\/eur-usd-ca-br"/);
  assert.match(markup, /Not yet evaluated/);
});

test("reputation empty state renders correctly", () => {
  const result = {
    status: 200,
    body: { reputation: [], count: 0 },
  } as const;

  const markup = renderToStaticMarkup(ReputationSectionView({ result }));
  assert.match(markup, /No anchors are currently persisted/);
});

test("reputation error state renders correctly", () => {
  const result = {
    status: 500,
    body: { error: { code: "internal_error", message: "Unable to load reputation." } },
  } as const;

  const markup = renderToStaticMarkup(ReputationSectionView({ result }));
  assert.match(markup, /Unable to load reputation/);
});