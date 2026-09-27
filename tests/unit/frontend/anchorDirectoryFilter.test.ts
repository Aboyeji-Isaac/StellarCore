import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  availableSepFilters,
  filterAnchorsBySeps,
} from "@/lib/frontend/anchorDirectoryFilter";
import type { PublicAnchorSummary } from "@/types/api/anchors";

function anchor(slug: string, seps: readonly number[]): PublicAnchorSummary {
  return Object.freeze({
    slug,
    name: slug[0]!.toUpperCase() + slug.slice(1),
    homeDomain: `${slug}.example`,
    status: "LIVE",
    seps: Object.freeze([...seps]),
    isTransferCapable: seps.includes(6) || seps.includes(24) || seps.includes(31),
    corridorCount: 1,
  });
}

const DIRECTORY = Object.freeze([
  anchor("zeam", [1, 10, 24, 31, 38]),
  anchor("cowrie", [1, 31]),
  anchor("moneygram", [1, 6, 24, 38]),
]);

test("no selected SEP shows every anchor", () => {
  const filtered = filterAnchorsBySeps(DIRECTORY, new Set());
  assert.equal(filtered.length, 3);
  assert.deepEqual(filtered.map(({ slug }) => slug), ["zeam", "cowrie", "moneygram"]);
});

test("one selected SEP shows only anchors advertising it", () => {
  const filtered = filterAnchorsBySeps(DIRECTORY, new Set([10]));
  assert.deepEqual(filtered.map(({ slug }) => slug), ["zeam"]);
});

test("multiple selected SEPs show anchors advertising at least one", () => {
  const filtered = filterAnchorsBySeps(DIRECTORY, new Set([10, 31]));
  assert.deepEqual(filtered.map(({ slug }) => slug).sort(), ["cowrie", "zeam"]);

  const filtered38 = filterAnchorsBySeps(DIRECTORY, new Set([38, 6]));
  assert.deepEqual(filtered38.map(({ slug }) => slug).sort(), ["moneygram", "zeam"]);
});

test("no matching anchors yields an empty result for the empty state", () => {
  const filtered = filterAnchorsBySeps(DIRECTORY, new Set([99]));
  assert.deepEqual(filtered, []);
});

test("available SEP options are derived from the data and sorted", () => {
  assert.deepEqual(availableSepFilters(DIRECTORY), [1, 6, 10, 24, 31, 38]);
  assert.deepEqual(availableSepFilters([anchor("single", [24]), anchor("other", [6, 38])]), [6, 24, 38]);
  assert.deepEqual(availableSepFilters([]), []);
});

test("filter functions return immutable results", () => {
  assert.equal(Object.isFrozen(filterAnchorsBySeps(DIRECTORY, new Set())), true);
  assert.equal(Object.isFrozen(availableSepFilters(DIRECTORY)), true);
});

test("the anchor directory uses a client-side only SEP filter over the existing API data", () => {
  const directorySource = readFileSync(
    resolve(process.cwd(), "components/anchors/AnchorDirectory.tsx"),
    "utf8",
  );
  assert.match(directorySource, /"use client"/);
  assert.match(directorySource, /filterAnchorsBySeps/);
  assert.match(directorySource, /useState/);
  // Filtering must not issue additional API requests.
  assert.doesNotMatch(directorySource, /fetch\(/);
  assert.doesNotMatch(directorySource, /fetch\("\/api\/anchors"\)/);
  assert.doesNotMatch(directorySource, /useEffect/);

  const pageSource = readFileSync(
    resolve(process.cwd(), "app/anchors/page.tsx"),
    "utf8",
  );
  assert.match(pageSource, /getAnchorsApiResult/);
  assert.doesNotMatch(pageSource, /"use client"/);
});