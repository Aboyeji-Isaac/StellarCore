import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { createElement } from "react";
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import axe from "axe-core";

// --- happy-dom global setup for @testing-library/react ---
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const globals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "HTMLInputElement",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "FocusEvent",
  "CustomEvent",
  "UIEvent",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
  "getComputedStyle",
  "ResizeObserver",
] as const;

for (const key of globals) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) {
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
}

Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "stellarcore-test/1.0" },
  configurable: true,
});

(globalThis as unknown as Record<string, unknown>).React = React;

afterEach(() => {
  cleanup();
});

import { SectionError, SectionSkeleton, SectionEmpty } from "@/components/dashboard/SectionStates";
import { Badge } from "@/components/dashboard/Badge";
import { RatePanel } from "@/components/dashboard/RatePanel";
import type { RatesApiDependencies } from "@/lib/api/rates";
import type { LatestCorridorRateReadResult } from "@/types/latestRates";

function el<P extends object>(
  type: React.ComponentType<P> | string,
  props: P,
  ...children: React.ReactNode[]
): ReturnType<typeof createElement> {
  return createElement(type, props, ...children);
}

function mockReadLatestRate(result: LatestCorridorRateReadResult): RatesApiDependencies {
  return {
    readLatestRate: async () => result,
  };
}

function healthyResponse(): LatestCorridorRateReadResult {
  return {
    ok: true,
    corridor: {
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    },
    evaluatedAt: "2026-08-28T12:00:00.000Z",
    state: "healthy",
    median: "0.175",
    totalIndependentSources: 2,
    freshSourceCount: 2,
    observations: [
      {
        snapshotId: "snap-1",
        anchorSlug: "zeam",
        anchorName: "Zeam",
        rate: "0.175",
        sourceAmount: "1.00",
        destinationAmount: "5.71",
        fee: "0.01",
        capturedAt: "2026-08-28T11:58:00.000Z",
        freshnessState: "fresh",
        ageMs: 120000,
        included: true,
      },
    ],
    exclusions: [],
  };
}

function insufficientResponse(): LatestCorridorRateReadResult {
  return {
    ok: true,
    corridor: {
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    },
    evaluatedAt: "2026-08-28T12:00:00.000Z",
    state: "insufficient_fresh_sources",
    median: null,
    totalIndependentSources: 1,
    freshSourceCount: 1,
    observations: [
      {
        snapshotId: "snap-1",
        anchorSlug: "zeam",
        anchorName: "Zeam",
        rate: "0.175",
        sourceAmount: "1.00",
        destinationAmount: "5.71",
        fee: "0.01",
        capturedAt: "2026-08-28T11:50:00.000Z",
        freshnessState: "stale",
        ageMs: 600000,
        included: false,
        exclusionReason: "stale",
      },
    ],
    exclusions: [],
  };
}

function emptyResponse(): LatestCorridorRateReadResult {
  return {
    ok: true,
    corridor: {
      slug: "usdc-us-brl-br",
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "BRL",
      countryTo: "BR",
    },
    evaluatedAt: "2026-08-28T12:00:00.000Z",
    state: "insufficient_fresh_sources",
    median: null,
    totalIndependentSources: 0,
    freshSourceCount: 0,
    observations: [],
    exclusions: [],
  };
}

function readFailure(): LatestCorridorRateReadResult {
  return {
    ok: false,
    corridorSlug: "usdc-us-brl-br",
    code: "READ_FAILURE",
  };
}

async function renderRatePanel(
  apiDependencies: RatesApiDependencies = {},
): Promise<ReturnType<typeof render>> {
  const panel = await RatePanel({ dependencies: apiDependencies });
  return render(panel);
}

test("SectionError exposes role=alert with the error message as its accessible name", () => {
  const { container, getByRole } = render(el(SectionError, { message: "Unable to load rates." }));

  const alert = getByRole("alert");
  assert.equal(alert.textContent, "Unable to load rates.");
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
});

test("SectionError re-render with unchanged message does not re-trigger the live region", () => {
  const { container, rerender } = render(el(SectionError, { message: "Unable to load rates." }));

  const alertBefore = container.querySelector('[role="alert"]');
  assert.ok(alertBefore, "expected one alert region");

  rerender(el(SectionError, { message: "Unable to load rates." }));

  const alertAfter = container.querySelector('[role="alert"]');
  assert.ok(alertAfter, "expected alert region to remain after re-render");
  assert.equal(alertBefore, alertAfter, "live region element must not be recreated");
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1, "no duplicate alert regions");
});

test("SectionError is not nested inside another live region", () => {
  const { container } = render(
    el("div", { role: "region", "aria-label": "outer" }, el(SectionError, { message: "Unable to load rates." })),
  );

  const alert = container.querySelector('[role="alert"]');
  assert.ok(alert);
  assert.equal(
    alert.closest('[role="alert"], [role="status"]'),
    alert,
    "alert must not be nested inside another live region",
  );
});

test("SectionSkeleton exposes role=status (polite) with a Loading accessible name", () => {
  const { getByRole } = render(el(SectionSkeleton, { label: "rates" }));

  const status = getByRole("status");
  assert.equal(status.getAttribute("aria-label"), "Loading rates");
});

test("SectionSkeleton re-render with unchanged label does not recreate the live region", () => {
  const { container, rerender } = render(el(SectionSkeleton, { label: "rates" }));

  const statusBefore = container.querySelector('[role="status"]');
  assert.ok(statusBefore, "expected one status region");

  rerender(el(SectionSkeleton, { label: "rates" }));

  const statusAfter = container.querySelector('[role="status"]');
  assert.ok(statusAfter, "expected status region to remain after re-render");
  assert.equal(statusBefore, statusAfter, "live region element must not be recreated");
  assert.equal(container.querySelectorAll('[role="status"]').length, 1, "no duplicate status regions");
});

test("SectionSkeleton instances are not duplicated or nested when multiple panels load", () => {
  const { container } = render(
    el(
      "div",
      {},
      el(SectionSkeleton, { label: "rates" }),
      el(SectionSkeleton, { label: "anchors" }),
      el(SectionSkeleton, { label: "reputation" }),
    ),
  );

  const statuses = container.querySelectorAll('[role="status"]');
  assert.equal(statuses.length, 3);
  for (const status of statuses) {
    assert.equal(
      status.closest('[role="status"], [role="alert"]'),
      status,
      "no status region nested inside another live region",
    );
  }
});

test("Badge renders visible text and is never icon-only", () => {
  const tones: ReadonlyArray<{
    tone: React.ComponentProps<typeof Badge>["tone"];
    label: string;
  }> = [
    { tone: "positive", label: "Synced" },
    { tone: "warning", label: "Sync degraded" },
    { tone: "negative", label: "Sync failed" },
    { tone: "neutral", label: "Sync unknown" },
  ];

  for (const { tone, label } of tones) {
    const { getByText } = render(el(Badge, { tone, label }));
    const badge = getByText(label);
    assert.ok(badge, `badge with tone ${tone} must render visible text`);
    assert.equal(badge.textContent, label);
  }
});

test("Badge communicates state through text, not color alone", () => {
  const { getByText } = render(el(Badge, { tone: "warning", label: "stale" }));
  const badge = getByText("stale");
  assert.ok(badge, "stale state must have a visible text label, not only a color");
});

test("SectionEmpty renders visible empty-state text", () => {
  const { getByText } = render(
    el(SectionEmpty, { message: "No rate observations are currently persisted for this corridor." }),
  );
  getByText("No rate observations are currently persisted for this corridor.");
});

test("RatePanel in error state renders role=alert with the error message", async () => {
  const { getByRole, container } = await renderRatePanel(mockReadLatestRate(readFailure()));

  const alert = getByRole("alert");
  assert.ok(alert.textContent?.includes("Unable to read rates"), "alert must state what happened");
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
  assert.equal(container.querySelectorAll('[role="status"]').length, 0);
});

test("RatePanel in fresh state renders badges with visible text labels", async () => {
  const { container, getByText } = await renderRatePanel(mockReadLatestRate(healthyResponse()));

  assert.equal(container.querySelectorAll('[role="alert"]').length, 0, "no alert in fresh state");
  assert.equal(container.querySelectorAll('[role="status"]').length, 0, "no status in fresh state");

  const freshnessBadge = getByText("fresh");
  assert.ok(freshnessBadge, "fresh observation badge must have visible text");
});

test("RatePanel in stale state renders badges with visible text stating how stale", async () => {
  const { container, getByText } = await renderRatePanel(mockReadLatestRate(insufficientResponse()));

  assert.equal(container.querySelectorAll('[role="alert"]').length, 0);
  assert.equal(container.querySelectorAll('[role="status"]').length, 0);

  const staleBadge = getByText("stale");
  assert.ok(staleBadge, "stale observation badge must have visible text");
});

test("RatePanel in empty state renders SectionEmpty with a meaningful message", async () => {
  const { getByText } = await renderRatePanel(mockReadLatestRate(emptyResponse()));

  getByText("No rate observations are currently persisted for this corridor.");
});

test("RatePanel axe scan passes in error state", async () => {
  const { container } = await renderRatePanel(mockReadLatestRate(readFailure()));

  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("RatePanel axe scan passes in fresh state", async () => {
  const { container } = await renderRatePanel(mockReadLatestRate(healthyResponse()));

  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("RatePanel axe scan passes in stale state", async () => {
  const { container } = await renderRatePanel(mockReadLatestRate(insufficientResponse()));

  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("RatePanel axe scan passes in empty state", async () => {
  const { container } = await renderRatePanel(mockReadLatestRate(emptyResponse()));

  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("SectionError passes axe scan", async () => {
  const { container } = render(el(SectionError, { message: "Unable to load rates." }));
  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("SectionSkeleton passes axe scan", async () => {
  const { container } = render(el(SectionSkeleton, { label: "rates" }));
  const results = await axe.run(container);
  assert.equal(results.violations.length, 0, JSON.stringify(results.violations, null, 2));
});

test("Badge passes axe scan in all tones", async () => {
  for (const tone of ["positive", "warning", "negative", "neutral"] as const) {
    const { container } = render(el(Badge, { tone, label: "Synced" }));
    const results = await axe.run(container);
    assert.equal(
      results.violations.length,
      0,
      `Badge tone ${tone} must pass axe: ${JSON.stringify(results.violations)}`,
    );
  }
});

test("dashboard panels do not use non-button elements as retry controls", () => {
  const { container } = render(el(SectionError, { message: "Unable to load rates." }));
  const nonButtonClickables = container.querySelectorAll("[onclick], [role='button']:not(button)");
  assert.equal(nonButtonClickables.length, 0, "no non-button retry-like controls");
});
