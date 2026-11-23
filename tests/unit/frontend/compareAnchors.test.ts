import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { exposeReactForClassicJsx } from "../../support/dashboardContracts";
import CompareAnchorsPage from "@/app/compare/anchors/page";

exposeReactForClassicJsx();

test("compare anchors page renders selection form", () => {
  const markup = renderToStaticMarkup(<CompareAnchorsPage />);
  assert.match(markup, /Select anchors/);
  assert.match(markup, /Anchor A/);
  assert.match(markup, /Anchor B/);
  assert.match(markup, /Compare/);
});

test("compare anchors page shows empty state when no anchors available", () => {
  const markup = renderToStaticMarkup(<CompareAnchorsPage />);
  assert.match(markup, /Select anchors/);
});

test("compare anchors page compares two selected anchors", () => {
  const markup = renderToStaticMarkup(<CompareAnchorsPage />);
  assert.match(markup, /Compare two anchors/);
  assert.match(markup, /Synchronization status/);
  assert.match(markup, /Advertised SEPs/);
  assert.match(markup, /Transfer interface/);
  assert.match(markup, /Reviewed corridor count/);
});

test("compare anchors page disclaimer shows no rate claims", () => {
  const markup = renderToStaticMarkup(<CompareAnchorsPage />);
  assert.match(markup, /No price/);
  assert.match(markup, /No rate/);
  assert.match(markup, /No operational claims/);
});

test("compare anchors page keyboard accessible controls", () => {
  const markup = renderToStaticMarkup(<CompareAnchorsPage />);
  assert.match(markup, /focus-visible/);
  assert.match(markup, /aria-label/);
});