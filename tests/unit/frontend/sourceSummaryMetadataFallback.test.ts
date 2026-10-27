import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

const ratePanelSource = read("components/dashboard/RatePanel.tsx");
const anchorsSectionSource = read("components/dashboard/AnchorsSection.tsx");
const reputationSectionSource = read("components/dashboard/ReputationSection.tsx");
const corridorRateEvidenceSource = read("components/corridors/CorridorRateEvidence.tsx");
const anchorPageSource = read("app/anchors/[slug]/page.tsx");
const corridorPageSource = read("app/corridors/[slug]/page.tsx");

test("evidence source summaries preserve stable identifier when optional display metadata is missing", () => {
  // In RatePanel observations table:
  assert.match(
    ratePanelSource,
    /observation\.anchor\.name\?\.trim\(\)\s*\?\s*observation\.anchor\.name\s*:\s*observation\.anchor\.slug/,
    "RatePanel must fall back to the stable anchor slug if anchor name is empty or missing",
  );

  // In CorridorRateEvidence observations table:
  assert.match(
    corridorRateEvidenceSource,
    /observation\.anchor\.name\?\.trim\(\)\s*\?\s*observation\.anchor\.name\s*:\s*observation\.anchor\.slug/,
    "CorridorRateEvidence must fall back to the stable anchor slug if anchor name is empty or missing",
  );

  // In AnchorsSection cards:
  assert.match(
    anchorsSectionSource,
    /anchor\.name\?\.trim\(\)\s*\?\s*anchor\.name\s*:\s*anchor\.slug/,
    "AnchorsSection must fall back to the stable anchor slug if anchor name is empty or missing",
  );

  // In ReputationSection cards:
  assert.match(
    reputationSectionSource,
    /entry\.anchor\.name\?\.trim\(\)\s*\?\s*entry\.anchor\.name\s*:\s*entry\.anchor\.slug/,
    "ReputationSection must fall back to the stable anchor slug if anchor name is empty or missing",
  );

  // In Anchor detail page header:
  assert.match(
    anchorPageSource,
    /anchor\.name\?\.trim\(\)\s*\?\s*anchor\.name\s*:\s*anchor\.slug/,
    "AnchorPage must fall back to the stable anchor slug if anchor name is empty or missing",
  );

  // In Corridor detail page associated anchors:
  assert.match(
    corridorPageSource,
    /anchor\.name\?\.trim\(\)\s*\?\s*anchor\.name\s*:\s*anchor\.slug/,
    "CorridorPage must fall back to the stable anchor slug if anchor name is empty or missing",
  );
});

test("missing home domain or optional descriptive metadata uses explicit neutral fallback", () => {
  // Missing home domain in AnchorsSection uses neutral placeholder "—"
  assert.match(
    anchorsSectionSource,
    /anchor\.homeDomain\?\.trim\(\)\s*\?\s*anchor\.homeDomain\s*:\s*"—"/,
    "AnchorsSection must use explicit neutral fallback '—' when homeDomain is missing",
  );

  // Missing home domain in Anchor detail page uses neutral placeholder "—"
  assert.match(
    anchorPageSource,
    /anchor\.homeDomain\?\.trim\(\)\s*\?\s*anchor\.homeDomain\s*:\s*"—"/,
    "AnchorPage must use explicit neutral fallback '—' when homeDomain is missing",
  );

  // Missing home domain in Corridor detail page uses neutral placeholder "—"
  assert.match(
    corridorPageSource,
    /anchor\.homeDomain\?\.trim\(\)\s*\?\s*anchor\.homeDomain\s*:\s*"—"/,
    "CorridorPage must use explicit neutral fallback '—' when homeDomain is missing",
  );

  // Missing advertised SEPs uses neutral placeholder "—"
  assert.match(
    anchorsSectionSource,
    /anchor\.seps\.length > 0 \? anchor\.seps\.join\(", "\) : "—"/,
  );
});

test("dashboard does not fabricate synthetic source names or freshness claims", () => {
  // Prohibit placeholder names like "Unknown Anchor", "Default Source", etc.
  for (const source of [ratePanelSource, anchorsSectionSource, reputationSectionSource, corridorRateEvidenceSource]) {
    assert.doesNotMatch(source, /"Unknown Anchor"|"Unnamed Source"|"Default Anchor"/i);
    assert.doesNotMatch(source, /"Always Fresh"|"Live Source"/i);
  }

  // Ensure RatePanel preserves honest unavailable median when evidence is insufficient
  assert.match(ratePanelSource, /medianRate === null \? "Median unavailable" : medianRate/);
  // Ensure ReputationSection explicitly states when evidence is too sparse
  assert.match(reputationSectionSource, /"Evidence is too sparse for a published score\."/);
  // Ensure CorridorRateEvidence explicitly preserves unavailable median
  assert.match(corridorRateEvidenceSource, /rates\.medianRate \?\? "Median unavailable"/);
});

test("source summary components maintain valid structural layout and accessibility with or without metadata", () => {
  // Tables retain stable headers and accessible attributes
  assert.match(ratePanelSource, /<table className="w-full min-w-\[640px\]/);
  assert.match(corridorRateEvidenceSource, /aria-label="Persisted rate observations"/);

  // Slugs are always retained as stable keys and accessible locators
  assert.match(ratePanelSource, /key=\{observation\.anchor\.slug\}/);
  assert.match(corridorRateEvidenceSource, /key=\{observation\.anchor\.slug\}/);
  assert.match(anchorsSectionSource, /key=\{anchor\.slug\}/);
  assert.match(anchorsSectionSource, /<p className="mt-0\.5 font-mono text-\[10px\] text-\[var\(--muted\)\]">\{anchor\.slug\}<\/p>/);
  assert.match(reputationSectionSource, /key=\{entry\.anchor\.slug\}/);
});
