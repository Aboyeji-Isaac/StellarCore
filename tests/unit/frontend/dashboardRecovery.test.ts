import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AnchorsSection, AnchorsSectionView } from "@/components/dashboard/AnchorsSection";
import { CorridorsSection, CorridorsSectionView } from "@/components/dashboard/CorridorsSection";
import { RatePanel, RatePanelView } from "@/components/dashboard/RatePanel";
import { ReputationSection, ReputationSectionView } from "@/components/dashboard/ReputationSection";
import { formatEvidenceTimestamp } from "@/components/ui/EvidenceTimestamp";
import type { AnchorsApiResult } from "@/types/api/anchors";
import type { CorridorsApiResult } from "@/types/api/corridors";
import type { RatesApiResult } from "@/types/api/rates";
import type { ReputationApiListResult } from "@/types/api/reputation";

const CAPTURE_TIME = "2026-08-28T11:58:00.000Z";
const EVALUATION_TIME = "2026-08-28T12:00:00.000Z";
const COMPUTED_TIME = "2026-08-28T12:02:00.000Z";

function rateSuccessResponse(medianRate = "5.25", capturedAt = CAPTURE_TIME): RatesApiResult {
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
      evaluatedAt: EVALUATION_TIME,
      state: "healthy",
      medianRate,
      sourceCount: 2,
      freshSourceCount: 2,
      reviewedCandidateConfiguration: { candidateCount: 2, uniqueAnchorCount: 2 },
      medianRequirement: { minimumFreshIndependentSources: 2 },
      observations: [
        {
          anchor: { slug: "zeam", name: "Zeam" },
          rate: medianRate,
          sourceAmount: "100",
          destinationAmount: "525",
          fee: "0.50",
          capturedAt,
          freshness: { state: "fresh", ageMs: 1_200 },
          eligibleForMedian: true,
        },
      ],
    },
  };
}

function rateErrorResponse(message = "Database connection offline."): RatesApiResult {
  return {
    status: 500,
    body: { error: { code: "internal_error", message } },
  };
}

function reputationSuccessResponse(score = 88): ReputationApiListResult {
  return {
    status: 200,
    body: {
      reputation: [
        {
          anchor: { slug: "zeam", name: "Zeam" },
          state: "established",
          score,
          scoreBand: "green",
          evidence: { outcomeCount: 142 },
          metrics: {
            fillRate7d: 0.99,
            fillRate30d: 0.98,
            fillRate90d: 0.97,
            settleP50Ms: 1200,
            settleP95Ms: 3400,
            slippageP50: 0.001,
            slippageP95: 0.005,
          },
          computedAt: COMPUTED_TIME,
        },
      ],
      count: 1,
    },
  };
}

function reputationErrorResponse(message = "Unable to load reputation."): ReputationApiListResult {
  return {
    status: 500,
    body: { error: { code: "internal_error", message } },
  };
}

function anchorsSuccessResponse(): AnchorsApiResult {
  return {
    status: 200,
    body: {
      anchors: [
        {
          slug: "zeam",
          name: "Zeam",
          homeDomain: "zeam.example",
          status: "LIVE",
          seps: [1, 24, 38],
          isTransferCapable: true,
          corridorCount: 2,
        },
      ],
      count: 1,
    },
  };
}

function anchorsErrorResponse(message = "Unable to load anchors."): AnchorsApiResult {
  return {
    status: 500,
    body: { error: { code: "internal_error", message } },
  };
}

function corridorsSuccessResponse(): CorridorsApiResult {
  return {
    status: 200,
    body: {
      corridors: [
        {
          slug: "usdc-us-brl-br",
          sourceAsset: "USDC",
          sourceCountry: "US",
          destinationAsset: "BRL",
          destinationCountry: "BR",
          anchorCount: 2,
        },
      ],
      count: 1,
    },
  };
}

function corridorsErrorResponse(message = "Unable to load corridors."): CorridorsApiResult {
  return {
    status: 500,
    body: { error: { code: "internal_error", message } },
  };
}

function timestampMarkup(value: string): string {
  return `<time dateTime="${value}">${formatEvidenceTimestamp(value)}</time>`;
}

test("RatePanel clears error state upon recovery and restores response data with freshness metadata", () => {
  // 1. Initial simulated transient database outage
  const outageHtml = renderToStaticMarkup(
    createElement(RatePanelView, { result: rateErrorResponse("Database connection offline.") }),
  );
  assert.match(outageHtml, /role="alert"/);
  assert.match(outageHtml, /Database connection offline\./);
  assert.doesNotMatch(outageHtml, /data-testid="rate-evidence-freshness"/);
  assert.doesNotMatch(outageHtml, /Median rate/);

  // 2. Subsequent successful response after recovery
  const recoveredHtml = renderToStaticMarkup(
    createElement(RatePanelView, { result: rateSuccessResponse("5.25", CAPTURE_TIME) }),
  );
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.doesNotMatch(recoveredHtml, /Database connection offline\./);
  assert.match(recoveredHtml, />5\.25<\/dd>/);
  assert.match(recoveredHtml, /USDC \(US\) → BRL \(BR\)/);
  assert.match(
    recoveredHtml,
    new RegExp(`Latest observation captured ${new Date(CAPTURE_TIME).toLocaleString()}`),
  );
  assert.ok(recoveredHtml.includes(timestampMarkup(EVALUATION_TIME)));
});

test("ReputationSection clears error state upon recovery and restores score and computation timestamp", () => {
  // 1. Outage
  const outageHtml = renderToStaticMarkup(
    createElement(ReputationSectionView, { result: reputationErrorResponse("Reputation database unreachable.") }),
  );
  assert.match(outageHtml, /role="alert"/);
  assert.match(outageHtml, /Reputation database unreachable\./);
  assert.doesNotMatch(outageHtml, /Computed/);

  // 2. Recovery
  const recoveredHtml = renderToStaticMarkup(
    createElement(ReputationSectionView, { result: reputationSuccessResponse(88) }),
  );
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.doesNotMatch(recoveredHtml, /Reputation database unreachable\./);
  assert.match(recoveredHtml, />88<\/span>/);
  assert.match(recoveredHtml, /Outcomes evaluated: <span[^>]*>142<\/span>/);
  assert.ok(recoveredHtml.includes(timestampMarkup(COMPUTED_TIME)));
});

test("AnchorsSection and CorridorsSection clear error state upon recovery", () => {
  // Anchors outage -> recovery
  const anchorOutageHtml = renderToStaticMarkup(
    createElement(AnchorsSectionView, { result: anchorsErrorResponse("Anchor directory down.") }),
  );
  assert.match(anchorOutageHtml, /role="alert"/);
  assert.match(anchorOutageHtml, /Anchor directory down\./);

  const anchorRecoveredHtml = renderToStaticMarkup(
    createElement(AnchorsSectionView, { result: anchorsSuccessResponse() }),
  );
  assert.doesNotMatch(anchorRecoveredHtml, /role="alert"/);
  assert.match(anchorRecoveredHtml, /Zeam/);
  assert.match(anchorRecoveredHtml, /zeam\.example/);
  assert.match(anchorRecoveredHtml, /Synced/);

  // Corridors outage -> recovery
  const corridorOutageHtml = renderToStaticMarkup(
    createElement(CorridorsSectionView, { result: corridorsErrorResponse("Corridor directory down.") }),
  );
  assert.match(corridorOutageHtml, /role="alert"/);
  assert.match(corridorOutageHtml, /Corridor directory down\./);

  const corridorRecoveredHtml = renderToStaticMarkup(
    createElement(CorridorsSectionView, { result: corridorsSuccessResponse() }),
  );
  assert.doesNotMatch(corridorRecoveredHtml, /role="alert"/);
  assert.match(corridorRecoveredHtml, /USDC · US/);
  assert.match(corridorRecoveredHtml, /BRL · BR/);
});

test("recovery in one panel does not incorrectly reset sibling panels", () => {
  // Sibling layout container helper
  function renderDashboardRow(
    rateResult: RatesApiResult,
    reputationResult: ReputationApiListResult,
  ): string {
    return renderToStaticMarkup(
      createElement(
        "div",
        null,
        createElement(RatePanelView, { result: rateResult }),
        createElement(ReputationSectionView, { result: reputationResult }),
      ),
    );
  }

  // State 1: Both panels experience database outage
  const bothFailedHtml = renderDashboardRow(
    rateErrorResponse("Rates database offline."),
    reputationErrorResponse("Reputation database offline."),
  );
  const alertCountBefore = (bothFailedHtml.match(/role="alert"/g) || []).length;
  assert.equal(alertCountBefore, 2);
  assert.match(bothFailedHtml, /Rates database offline\./);
  assert.match(bothFailedHtml, /Reputation database offline\./);

  // State 2: Rate panel recovers first, sibling reputation panel remains in outage
  const rateRecoveredSiblingFailedHtml = renderDashboardRow(
    rateSuccessResponse("5.40", CAPTURE_TIME),
    reputationErrorResponse("Reputation database offline."),
  );
  // Rate error cleared, rate data and freshness present
  assert.doesNotMatch(rateRecoveredSiblingFailedHtml, /Rates database offline\./);
  assert.match(rateRecoveredSiblingFailedHtml, />5\.40<\/dd>/);
  assert.match(
    rateRecoveredSiblingFailedHtml,
    new RegExp(`Latest observation captured ${new Date(CAPTURE_TIME).toLocaleString()}`),
  );
  // Sibling reputation panel remains safely in error state without being incorrectly reset
  assert.match(rateRecoveredSiblingFailedHtml, /role="alert"/);
  assert.match(rateRecoveredSiblingFailedHtml, /Reputation database offline\./);
  assert.doesNotMatch(rateRecoveredSiblingFailedHtml, />88<\/span>/);

  // State 3: Sibling reputation panel subsequently recovers
  const bothRecoveredHtml = renderDashboardRow(
    rateSuccessResponse("5.40", CAPTURE_TIME),
    reputationSuccessResponse(94),
  );
  // Both errors cleared
  assert.doesNotMatch(bothRecoveredHtml, /role="alert"/);
  // Rate data undisturbed
  assert.match(bothRecoveredHtml, />5\.40<\/dd>/);
  assert.match(
    bothRecoveredHtml,
    new RegExp(`Latest observation captured ${new Date(CAPTURE_TIME).toLocaleString()}`),
  );
  // Reputation data now active
  assert.match(bothRecoveredHtml, />94<\/span>/);
  assert.ok(bothRecoveredHtml.includes(timestampMarkup(COMPUTED_TIME)));

  // State 4: Transient failure in sibling reputation panel does NOT reset healthy rate panel
  const reputationFailedAgainHtml = renderDashboardRow(
    rateSuccessResponse("5.40", CAPTURE_TIME),
    reputationErrorResponse("Temporary reputation read timeout."),
  );
  // Rate panel data and freshness remain untouched
  assert.match(reputationFailedAgainHtml, />5\.40<\/dd>/);
  assert.match(
    reputationFailedAgainHtml,
    new RegExp(`Latest observation captured ${new Date(CAPTURE_TIME).toLocaleString()}`),
  );
  // Sibling has isolated alert
  assert.match(reputationFailedAgainHtml, /Temporary reputation read timeout\./);
});

test("async server components simulate unavailable-then-available sequence deterministically", async () => {
  let isOutage = true;

  // RatePanel async server component with injected read dependency
  const rateComponentProps = {
    dependencies: {
      now: () => new Date(EVALUATION_TIME),
      reportError: () => {},
      staleEvidenceStore: {
        read: async () => null,
        write: async () => {},
      },
      readLatestRate: async (slug: string) => {
        if (isOutage) {
          throw new Error("Simulated database outage");
        }
        return {
          ok: true as const,
          corridor: {
            slug,
            assetCodeFrom: "USDC",
            countryFrom: "US",
            assetCodeTo: "BRL",
            countryTo: "BR",
          },
          evaluatedAt: EVALUATION_TIME,
          state: "healthy" as const,
          median: "5.50",
          totalIndependentSources: 2,
          freshSourceCount: 2,
          observations: [
            {
              snapshotId: "snapshot-1",
              anchorSlug: "zeam",
              anchorName: "Zeam",
              rate: "5.50",
              sourceAmount: "100",
              destinationAmount: "550",
              fee: "0",
              capturedAt: CAPTURE_TIME,
              freshnessState: "fresh" as const,
              ageMs: 1_000,
              included: true,
            },
          ],
          exclusions: [],
        };
      },
    },
  };

  // Step 1: Execute during outage
  const failureVNode = await RatePanel(rateComponentProps);
  const failureHtml = renderToStaticMarkup(failureVNode);
  assert.match(failureHtml, /role="alert"/);
  assert.match(failureHtml, /Unable to read rates\./);
  assert.doesNotMatch(failureHtml, />5\.50<\/dd>/);

  // Step 2: Database recovers
  isOutage = false;
  const recoveredVNode = await RatePanel(rateComponentProps);
  const recoveredHtml = renderToStaticMarkup(recoveredVNode);
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.match(recoveredHtml, />5\.50<\/dd>/);
  assert.match(
    recoveredHtml,
    new RegExp(`Latest observation captured ${new Date(CAPTURE_TIME).toLocaleString()}`),
  );

  // ReputationSection async server component recovery
  let reputationOutage = true;
  const repProps = {
    dependencies: {
      now: () => new Date(EVALUATION_TIME),
      reportError: () => {},
      staleEvidenceStore: { read: async () => null, write: async () => {} },
      repository: {
        findAll: async () => {
          if (reputationOutage) throw new Error("Reputation DB down");
          return [
            {
              slug: "zeam",
              name: "Zeam",
              reputationScore: {
                compositeScore: 91,
                scoreBand: "GREEN" as const,
                fillRate7d: 0.99,
                fillRate30d: 0.98,
                fillRate90d: 0.97,
                settleP50Ms: 1200,
                settleP95Ms: 3400,
                slippageP50: 0.001,
                slippageP95: 0.005,
                sampleSize: 40,
                state: "OK" as const,
                computedAt: new Date(COMPUTED_TIME),
              },
            },
          ];
        },
        findBySlug: async () => null,
      },
    },
  };
  const repFailHtml = renderToStaticMarkup(await ReputationSection(repProps));
  assert.match(repFailHtml, /role="alert"/);
  reputationOutage = false;
  const repRecoveredHtml = renderToStaticMarkup(await ReputationSection(repProps));
  assert.doesNotMatch(repRecoveredHtml, /role="alert"/);
  assert.match(repRecoveredHtml, />91<\/span>/);

  // AnchorsSection async server component recovery
  let anchorsOutage = true;
  const anchorProps = {
    dependencies: {
      reportError: () => {},
      repository: {
        findAll: async () => {
          if (anchorsOutage) throw new Error("Anchors DB down");
          return [
            {
              slug: "zeam",
              name: "Zeam",
              homeDomain: "zeam.example",
              status: "LIVE" as const,
              seps: [1, 24],
              corridorCount: 1,
            },
          ];
        },
        findBySlug: async () => null,
      },
    },
  };
  const anchorFailHtml = renderToStaticMarkup(await AnchorsSection(anchorProps));
  assert.match(anchorFailHtml, /role="alert"/);
  anchorsOutage = false;
  const anchorRecoveredHtml = renderToStaticMarkup(await AnchorsSection(anchorProps));
  assert.doesNotMatch(anchorRecoveredHtml, /role="alert"/);
  assert.match(anchorRecoveredHtml, /Zeam/);

  // CorridorsSection async server component recovery
  let corridorsOutage = true;
  const corridorProps = {
    dependencies: {
      reportError: () => {},
      repository: {
        findAll: async () => {
          if (corridorsOutage) throw new Error("Corridors DB down");
          return [
            {
              slug: "usdc-us-brl-br",
              assetCodeFrom: "USDC",
              countryFrom: "US",
              assetCodeTo: "BRL",
              countryTo: "BR",
              anchorCount: 1,
            },
          ];
        },
      },
    },
  };
  const corridorFailHtml = renderToStaticMarkup(await CorridorsSection(corridorProps));
  assert.match(corridorFailHtml, /role="alert"/);
  corridorsOutage = false;
  const corridorRecoveredHtml = renderToStaticMarkup(await CorridorsSection(corridorProps));
  assert.doesNotMatch(corridorRecoveredHtml, /role="alert"/);
  assert.match(corridorRecoveredHtml, /USDC · US/);
});
