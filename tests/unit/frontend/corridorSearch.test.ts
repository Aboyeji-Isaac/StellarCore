import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { searchCorridors } from "@/lib/frontend/corridorSearch";
import type { PublicCorridor } from "@/types/api/corridors";

function corridor(
  slug: string,
  sourceAsset: string,
  sourceCountry: string,
  destinationAsset: string,
  destinationCountry: string,
  anchorCount = 1,
): PublicCorridor {
  return Object.freeze({
    slug,
    sourceAsset,
    sourceCountry,
    destinationAsset,
    destinationCountry,
    anchorCount,
  });
}

const CORRIDORS = Object.freeze([
  corridor("usdc-us-brl-br", "USDC", "US", "BRL", "BR"),
  corridor("ngnt-ng-ngn-ng", "NGNT", "NG", "NGN", "NG"),
  corridor("uet-eur-usdc-us", "UET", "EUR", "USDC", "US"),
]);

test("an empty search shows every corridor", () => {
  const results = searchCorridors(CORRIDORS, "");
  assert.equal(results.length, 3);
  assert.deepEqual(results.map(({ slug }) => slug), ["usdc-us-brl-br", "ngnt-ng-ngn-ng", "uet-eur-usdc-us"]);
});

test("whitespace-only search shows every corridor", () => {
  const results = searchCorridors(CORRIDORS, "   ");
  assert.equal(results.length, 3);
});

test("search matches the source asset code", () => {
  const results = searchCorridors(CORRIDORS, "NGNT");
  assert.deepEqual(results.map(({ slug }) => slug), ["ngnt-ng-ngn-ng"]);
});

test("search matches the destination asset code", () => {
  const results = searchCorridors(CORRIDORS, "BRL");
  assert.deepEqual(results.map(({ slug }) => slug), ["usdc-us-brl-br"]);
});

test("search matches a country on either end", () => {
  const results = searchCorridors(CORRIDORS, "NG");
  assert.deepEqual(results.map(({ slug }) => slug), ["ngnt-ng-ngn-ng"]);
});

test("search is case-insensitive", () => {
  assert.equal(searchCorridors(CORRIDORS, "usdc").length, 2);
  assert.equal(searchCorridors(CORRIDORS, "USDC").length, 2);
  assert.equal(searchCorridors(CORRIDORS, "br").length, 1); // BRL destination and BR country
  assert.equal(searchCorridors(CORRIDORS, "BR").length, 1);
});

test("search is substring-based", () => {
  const results = searchCorridors(CORRIDORS, "US");
  // Matches USDC source (usdc-us-brl-br and uet-eur-usdc-us) and the US source/destination countries.
  assert.equal(results.length, 2);
  assert.deepEqual(results.map(({ slug }) => slug).sort(), ["uet-eur-usdc-us", "usdc-us-brl-br"].sort());
});

test("search with no matches returns an empty result", () => {
  const results = searchCorridors(CORRIDORS, "BTC");
  assert.deepEqual(results, []);
});

test("clearing the search restores the full list", () => {
  assert.equal(searchCorridors(CORRIDORS, "BRL").length, 1);
  assert.equal(searchCorridors(CORRIDORS, "").length, 3);
});

test("search results are immutable", () => {
  assert.equal(Object.isFrozen(searchCorridors(CORRIDORS, "USDC")), true);
});

test("the corridor directory searches client-side over the existing API data", () => {
  const directorySource = readFileSync(
    resolve(process.cwd(), "components/corridors/CorridorDirectory.tsx"),
    "utf8",
  );
  assert.match(directorySource, /"use client"/);
  assert.match(directorySource, /searchCorridors/);
  assert.match(directorySource, /type="search"/);
  // Search must not issue additional API requests.
  assert.doesNotMatch(directorySource, /fetch\(/);
  assert.doesNotMatch(directorySource, /fetch\("\/api\/corridors"\)/);
  assert.doesNotMatch(directorySource, /useEffect/);

  const pageSource = readFileSync(
    resolve(process.cwd(), "app/corridors/page.tsx"),
    "utf8",
  );
  assert.match(pageSource, /getCorridorsApiResult/);
  assert.doesNotMatch(pageSource, /"use client"/);
});