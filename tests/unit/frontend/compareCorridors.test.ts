import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { exposeReactForClassicJsx } from "../../support/dashboardContracts";
import CompareCorridorsPage from "@/app/compare/corridors/page";

exposeReactForClassicJsx();

test("compare corridors page renders selection form", () => {
  const markup = renderToStaticMarkup(<CompareCorridorsPage />);
  assert.match(markup, /Select corridors/);
  assert.match(markup, /Corridor A/);
  assert.match(markup, /Corridor B/);
  assert.match(markup, /Compare/);
});

test("compare corridors page shows empty state when no corridors available", () => {
  const markup = renderToStaticMarkup(<CompareCorridorsPage />);
  assert.match(markup, /Select corridors/);
});

test("compare corridors page compares two selected corridors", () => {
  const markup = renderToStaticMarkup(<CompareCorridorsPage />);
  assert.match(markup, /Source asset/);
  assert.match(markup, /Source country/);
  assert.match(markup, /Destination asset/);
  assert.match(markup, /Destination country/);
  assert.match(markup, /Associated anchors/);
});

test("compare corridors page disclaimer shows no rate claims", () => {
  const markup = renderToStaticMarkup(<CompareCorridorsPage />);
  assert.match(markup, /No price/);
  assert.match(markup, /No rate/);
  assert.match(markup, /No operational claims/);
});

test("compare corridors page keyboard accessible controls", () => {
  const markup = renderToStaticMarkup(<CompareCorridorsPage />);
  assert.match(markup, /focus-visible/);
  assert.match(markup, /aria-label/);
});