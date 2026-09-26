import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const anchorPageSource = readFileSync(
  new URL("../../../app/anchors/[slug]/page.tsx", import.meta.url),
  "utf8",
);

test("anchor detail page consumes the persisted anchor API and keeps the Synced convention", () => {
  assert.match(anchorPageSource, /import \{ getAnchorApiResult \} from "@\/lib\/api\/anchors"/);
  assert.match(anchorPageSource, /import \{ getAnchorReputationApiResult \} from "@\/lib\/api\/reputation"/);
  assert.match(anchorPageSource, /import \{ advertisedCapabilities \} from "@\/lib\/stellar\/advertisedCapabilities"/);
  assert.match(anchorPageSource, /case "LIVE":[\s\S]*?label: "Synced"/);
  assert.doesNotMatch(anchorPageSource, /case "LIVE":[\s\S]*?label: "Live"/);
});

test("anchor detail page never renders a fabricated reputation score or median", () => {
  assert.match(anchorPageSource, /"insufficient evidence"|Insufficient evidence/);
  assert.match(anchorPageSource, /"This anchor has no persisted evaluation yet\."/);
  assert.match(anchorPageSource, /"Evidence is too sparse for a published score\."/);
  assert.doesNotMatch(anchorPageSource, /medianRate|compositeScore/);
  assert.doesNotMatch(anchorPageSource, /score: \d+/);
});

test("anchor detail page preserves the advertised-metadata caveat and 404 boundary", () => {
  assert.match(
    anchorPageSource,
    /SEP-38 advertisement does not establish a reviewed indicative-rate source/,
  );
  assert.match(anchorPageSource, /notFound\(\)/);
  assert.match(anchorPageSource, /href=\{`\/corridors\/\$\{corridor\.slug\}`\}/);
});