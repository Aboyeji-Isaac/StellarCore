import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Ensure React is available on globalThis for Next.js Server Components running under Node test runner
const globalScope = globalThis as typeof globalThis & {
  React?: typeof React;
  prisma?: unknown;
  pool?: unknown;
};
globalScope.React = React;

// Isolate stale evidence store before importing any API route or component dependencies
process.env.STALE_EVIDENCE_DIRECTORY = mkdtempSync(
  join(tmpdir(), "stellarcore-dashboard-isolation-test-"),
);

import { AnchorsSection } from "@/components/dashboard/AnchorsSection";
import { CorridorsSection } from "@/components/dashboard/CorridorsSection";
import { RatePanel } from "@/components/dashboard/RatePanel";
import { ReputationSection } from "@/components/dashboard/ReputationSection";
import type { Prisma } from "@/app/generated/prisma/client";

const MALFORMED_PAYLOAD_SNIPPET = "<html>502 Bad Gateway: unparseable upstream body</html>";

type PanelName = "anchors" | "corridors" | "rates" | "reputation";

let activeMalformedPanel: PanelName | null = null;

function setMalformedPanel(panel: PanelName | null) {
  activeMalformedPanel = panel;
}

function throwOnMalformed(panel: PanelName) {
  if (activeMalformedPanel === panel) {
    // Intentionally execute JSON.parse with malformed non-JSON text to simulate unparseable response
    JSON.parse(MALFORMED_PAYLOAD_SNIPPET);
  }
}

globalScope.prisma = {
  anchor: {
    findMany: async (args?: { select?: { reputationScore?: unknown } }) => {
      if (args?.select?.reputationScore) {
        throwOnMalformed("reputation");
        return [
          {
            slug: "zeam",
            name: "Zeam",
            reputationScore: {
              compositeScore: 85,
              scoreBand: "GREEN",
              fillRate7d: 0.99,
              fillRate30d: 0.98,
              fillRate90d: 0.95,
              settleP50Ms: 1200,
              settleP95Ms: 2500,
              slippageP50: 0.001,
              slippageP95: 0.005,
              sampleSize: 150,
              state: "OK",
              computedAt: new Date("2026-08-28T12:00:00Z"),
            },
          },
        ];
      }

      throwOnMalformed("anchors");
      return [
        {
          slug: "zeam",
          name: "Zeam",
          homeDomain: "zeam.example",
          status: "LIVE",
          seps: [1, 38],
          _count: { corridors: 1 },
        },
      ];
    },
  },
  corridor: {
    findMany: async () => {
      throwOnMalformed("corridors");
      return [
        {
          slug: "usdc-us-brl-br",
          assetCodeFrom: "USDC",
          countryFrom: "US",
          assetCodeTo: "BRL",
          countryTo: "BR",
          _count: { anchors: 1 },
        },
      ];
    },
    findUnique: async () => {
      throwOnMalformed("rates");
      return {
        id: "corridor-1",
        slug: "usdc-us-brl-br",
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      };
    },
  },
  $queryRaw: async () => {
    throwOnMalformed("rates");
    return [
      {
        id: "snapshot-1",
        anchorSlug: "zeam",
        anchorName: "Zeam",
        rate: { toString: () => "5.20" } as Prisma.Decimal,
        sourceAmount: { toString: () => "100" } as Prisma.Decimal,
        destinationAmount: { toString: () => "520" } as Prisma.Decimal,
        fee: { toString: () => "0" } as Prisma.Decimal,
        capturedAt: new Date("2026-08-28T12:00:00Z"),
      },
    ];
  },
  scheduledSourceSuppression: {
    findMany: async () => [],
  },
  reputationScore: {
    findMany: async () => [],
  },
};
globalScope.pool = {};

async function renderPanel(panel: PanelName): Promise<string> {
  switch (panel) {
    case "anchors":
      return renderToStaticMarkup(await AnchorsSection());
    case "corridors":
      return renderToStaticMarkup(await CorridorsSection());
    case "rates":
      return renderToStaticMarkup(await RatePanel());
    case "reputation":
      return renderToStaticMarkup(await ReputationSection());
  }
}

test("malformed JSON in anchors panel renders error state while sibling panels retain data", async () => {
  setMalformedPanel("anchors");

  const anchorsHtml = await renderPanel("anchors");
  const corridorsHtml = await renderPanel("corridors");
  const ratesHtml = await renderPanel("rates");
  const reputationHtml = await renderPanel("reputation");

  // Affected panel shows clear error state and hides data
  assert.match(anchorsHtml, /role="alert"/);
  assert.match(anchorsHtml, /Unable to load anchors\./);
  assert.equal(anchorsHtml.includes(MALFORMED_PAYLOAD_SNIPPET), false, "Raw contents must not leak");

  // Sibling panels retain their data and do not enter error state
  assert.doesNotMatch(corridorsHtml, /role="alert"/);
  assert.match(corridorsHtml, /USDC · US/);
  assert.match(corridorsHtml, /BRL · BR/);

  assert.doesNotMatch(ratesHtml, /role="alert"/);
  assert.match(ratesHtml, /USDC \(US\) → BRL \(BR\)/);

  assert.doesNotMatch(reputationHtml, /role="alert"/);
  assert.match(reputationHtml, /Zeam/);
  assert.match(reputationHtml, /Established/);

  // Subsequent valid response recovers the affected panel
  setMalformedPanel(null);
  const recoveredHtml = await renderPanel("anchors");
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.match(recoveredHtml, /Zeam/);
  assert.match(recoveredHtml, /zeam\.example/);
});

test("malformed JSON in corridors panel renders error state while sibling panels retain data", async () => {
  setMalformedPanel("corridors");

  const corridorsHtml = await renderPanel("corridors");
  const anchorsHtml = await renderPanel("anchors");
  const ratesHtml = await renderPanel("rates");
  const reputationHtml = await renderPanel("reputation");

  assert.match(corridorsHtml, /role="alert"/);
  assert.match(corridorsHtml, /Unable to load corridors\./);
  assert.equal(corridorsHtml.includes(MALFORMED_PAYLOAD_SNIPPET), false, "Raw contents must not leak");

  assert.doesNotMatch(anchorsHtml, /role="alert"/);
  assert.match(anchorsHtml, /Zeam/);

  assert.doesNotMatch(ratesHtml, /role="alert"/);
  assert.match(ratesHtml, /USDC \(US\) → BRL \(BR\)/);

  assert.doesNotMatch(reputationHtml, /role="alert"/);
  assert.match(reputationHtml, /Zeam/);

  // Subsequent recovery
  setMalformedPanel(null);
  const recoveredHtml = await renderPanel("corridors");
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.match(recoveredHtml, /USDC · US/);
});

test("malformed JSON in rates panel renders error state while sibling panels retain data", async () => {
  setMalformedPanel("rates");

  const ratesHtml = await renderPanel("rates");
  const anchorsHtml = await renderPanel("anchors");
  const corridorsHtml = await renderPanel("corridors");
  const reputationHtml = await renderPanel("reputation");

  assert.match(ratesHtml, /role="alert"/);
  assert.match(ratesHtml, /Unable to read rates\./);
  assert.equal(ratesHtml.includes(MALFORMED_PAYLOAD_SNIPPET), false, "Raw contents must not leak");

  assert.doesNotMatch(anchorsHtml, /role="alert"/);
  assert.match(anchorsHtml, /Zeam/);

  assert.doesNotMatch(corridorsHtml, /role="alert"/);
  assert.match(corridorsHtml, /USDC · US/);

  assert.doesNotMatch(reputationHtml, /role="alert"/);
  assert.match(reputationHtml, /Zeam/);

  // Subsequent recovery
  setMalformedPanel(null);
  const recoveredHtml = await renderPanel("rates");
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.match(recoveredHtml, /USDC \(US\) → BRL \(BR\)/);
});

test("malformed JSON in reputation panel renders error state while sibling panels retain data", async () => {
  setMalformedPanel("reputation");

  const reputationHtml = await renderPanel("reputation");
  const anchorsHtml = await renderPanel("anchors");
  const corridorsHtml = await renderPanel("corridors");
  const ratesHtml = await renderPanel("rates");

  assert.match(reputationHtml, /role="alert"/);
  assert.match(reputationHtml, /Unable to load reputation\./);
  assert.equal(reputationHtml.includes(MALFORMED_PAYLOAD_SNIPPET), false, "Raw contents must not leak");

  assert.doesNotMatch(anchorsHtml, /role="alert"/);
  assert.match(anchorsHtml, /Zeam/);

  assert.doesNotMatch(corridorsHtml, /role="alert"/);
  assert.match(corridorsHtml, /USDC · US/);

  assert.doesNotMatch(ratesHtml, /role="alert"/);
  assert.match(ratesHtml, /USDC \(US\) → BRL \(BR\)/);

  // Subsequent recovery
  setMalformedPanel(null);
  const recoveredHtml = await renderPanel("reputation");
  assert.doesNotMatch(recoveredHtml, /role="alert"/);
  assert.match(recoveredHtml, /Zeam/);
  assert.match(recoveredHtml, /Established/);
});
