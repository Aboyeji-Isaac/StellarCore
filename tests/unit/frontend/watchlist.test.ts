import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { exposeReactForClassicJsx } from "../../support/dashboardContracts";
import WatchlistPage from "./app/watchlist/page"; // relative path

exposeReactForClassicJsx();

test("watchlist renders empty state when no items stored", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /No bookmarks yet/);
  assert.match(markup, /Select anchors or corridors below/);
});

test("watchlist renders add anchors section", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /Add anchors/);
  assert.match(markup, /Select anchors from the public list/);
});

test("watchlist renders add corridors section", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /Add corridors/);
  assert.match(markup, /Select corridors from the public list/);
});

test("watchlist shows bookmark removal", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /No bookmarks yet/);
  // Removal controls are present in the UI even when empty
  assert.match(markup, /Remove/);
});

test("watchlist explains persistence is browser-local", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /persist only in this browser/);
  assert.match(markup, /Clearing browsing data will remove them/);
});

test("watchlist explains it's a bookmark list not monitoring", () => {
  const markup = renderToStaticMarkup(<WatchlistPage />);
  assert.match(markup, /bookmark list only/);
  assert.match(markup, /no automatic monitoring/);
  assert.match(markup, /no alerts/);
});