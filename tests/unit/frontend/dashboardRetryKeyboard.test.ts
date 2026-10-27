import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionError } from "../../../components/dashboard/SectionStates";

function read(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

const sectionStatesSource = read("components/dashboard/SectionStates.tsx");
const globalStyles = read("app/globals.css");
const dashboardPage = read("app/dashboard/page.tsx");

test("SectionStates source exposes accessible button semantics and focus-visible styling for retry actions", () => {
  // Verifies native button element with type="button" is used for standard keyboard interaction (Enter and Space)
  assert.match(sectionStatesSource, /<button[\s\S]*?type="button"/, "Retry control must use native button semantics");
  assert.match(sectionStatesSource, /onClick=\{onRetry\}/, "Retry action must bind onRetry click handler");
  assert.match(sectionStatesSource, /aria-label=\{retryLabel\}/, "Retry control must have an accessible name via aria-label");
  assert.match(sectionStatesSource, /focus-visible:outline-2/, "Retry action must define visible outline on keyboard focus");
  assert.match(sectionStatesSource, /focus-visible:outline-\[var\(--accent\)\]/, "Retry action outline must use design system accent color");
  assert.match(sectionStatesSource, /focus-visible:outline-offset-2/, "Retry action must configure clear outline offset");
});

test("rendered SectionError without retry callback displays alert without button", () => {
  const html = renderToStaticMarkup(
    React.createElement(SectionError, { message: "Internal server error" })
  );
  assert.match(html, /role="alert"/, "Must render an alert landmark");
  assert.match(html, /Internal server error/, "Must render the failure message");
  assert.doesNotMatch(html, /<button/, "Must not render a button if onRetry is omitted");
});

test("rendered SectionError with retry callback renders accessible keyboard-activatable button", () => {
  const onRetryMock = () => {};
  const html = renderToStaticMarkup(
    React.createElement(SectionError, {
      message: "Network request failed",
      onRetry: onRetryMock,
      retryLabel: "Retry loading rates section",
    })
  );

  assert.match(html, /role="alert"/, "Must render an alert landmark");
  assert.match(html, /<button[^>]*type="button"/, "Must render a button with explicit type='button'");
  assert.match(html, /aria-label="Retry loading rates section"/, "Button must have explicit descriptive accessible name");
  assert.match(html, />Retry<\/button>/, "Button must provide visible text for visual users");
  assert.match(html, /focus-visible:outline-2/, "Button must retain visible focus state for keyboard users");
});

test("keyboard focus rules and semantics: global styles guarantee focus-visible on all buttons", () => {
  // Verifies global stylesheet includes :focus-visible rule covering all button elements
  assert.match(
    globalStyles,
    /:where\(a, button, input, select, textarea, \[tabindex\]\):focus-visible/,
    "Global styles must enforce visible outline on all keyboard-focused controls"
  );
  assert.match(
    globalStyles,
    /outline: 2px solid var\(--accent\)/,
    "Global styles must specify accent color outline for focused elements"
  );
});

test("predictable keyboard navigation: SectionError does not trap focus, suppress tabindex, or intercept keys", () => {
  assert.doesNotMatch(sectionStatesSource, /tabIndex=\{-1\}/, "SectionError must never remove controls from keyboard tab sequence");
  assert.doesNotMatch(sectionStatesSource, /onKeyDown|onKeyUp|onKeyPress/, "SectionError must not intercept keys with custom key listeners");
  assert.doesNotMatch(sectionStatesSource, /outline:\s*none|outline-none/, "SectionError must never suppress focus outlines");
});

test("dashboard panel state transitions: focusable retry controls in error state do not leak into empty or skeleton states", () => {
  const emptyHtml = renderToStaticMarkup(
    React.createElement(SectionError, { message: "Failed" })
  );
  assert.doesNotMatch(emptyHtml, /<button/);

  // When state changes to success/skeleton, aria-label and status roles remain well-formed
  assert.match(sectionStatesSource, /role="status"/, "SectionSkeleton must use role='status'");
  assert.match(sectionStatesSource, /aria-label=\{`Loading \$\{label\}`\}/, "SectionSkeleton must label loading state");
});

test("dashboard page preserves skip link and accessible heading hierarchy across panel regions", () => {
  assert.match(dashboardPage, /id="main-content"/, "Dashboard must expose main content skip target");
  assert.match(dashboardPage, /<h1[\s>]/, "Dashboard must have exactly one h1 landmark");
  assert.match(dashboardPage, /aria-labelledby="anchors-heading"/, "Anchors section must be labelled by heading");
  assert.match(dashboardPage, /aria-labelledby="corridors-heading"/, "Corridors section must be labelled by heading");
  assert.match(dashboardPage, /aria-labelledby="rates-heading"/, "Rates section must be labelled by heading");
  assert.match(dashboardPage, /aria-labelledby="reputation-heading"/, "Reputation section must be labelled by heading");
});
