import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const landingSource = readFileSync(
  new URL("../../../components/landing/LandingPage.tsx", import.meta.url),
  "utf8",
);
const worldMapGeometrySource = readFileSync(
  new URL("../../../components/landing/worldMapGeometry.ts", import.meta.url),
  "utf8",
);
const homeSource = readFileSync(
  new URL("../../../app/page.tsx", import.meta.url),
  "utf8",
);
const headerSource = readFileSync(
  new URL("../../../components/ui/ProductHeader.tsx", import.meta.url),
  "utf8",
);
const dashboardSource = readFileSync(
  new URL("../../../app/dashboard/page.tsx", import.meta.url),
  "utf8",
);
const anchorsSource = readFileSync(
  new URL("../../../components/dashboard/AnchorsSection.tsx", import.meta.url),
  "utf8",
);
const ratePanelSource = readFileSync(
  new URL("../../../components/dashboard/RatePanel.tsx", import.meta.url),
  "utf8",
);
const globalStyles = readFileSync(
  new URL("../../../app/globals.css", import.meta.url),
  "utf8",
);

test("landing source contains none of the known synthetic product claims", () => {
  const forbiddenClaims = [
    "27 anchors reporting",
    "Best route now",
    "0.31% total spread",
    "Live corridor pricing",
    "Best quote",
    "Active anchors",
    "Open corridors",
    "12.4",
    "99.98",
    "ClickPesa",
    "Settle",
  ];

  for (const claim of forbiddenClaims) {
    assert.equal(landingSource.includes(claim), false, `found synthetic claim: ${claim}`);
  }
});

test("landing source contains none of the known transfer-execution positioning", () => {
  const forbiddenLanguage = [
    "Execution intelligence",
    "execution layer",
    "move the value",
    "Move with context",
    "Enter the network",
  ];

  for (const claim of forbiddenLanguage) {
    assert.equal(landingSource.includes(claim), false, `found execution claim: ${claim}`);
  }

  assert.match(landingSource, /Read-only Stellar intelligence/);
  assert.match(landingSource, /Inspect anchors, corridors, rate evidence, and reputation/);
});

test("visible landing calls to action point to their stated destinations", () => {
  assert.match(landingSource, /href="\/dashboard">\s*Inspect the dashboard/);
  assert.match(landingSource, /href="\/dashboard">Open dashboard/);
  assert.match(landingSource, /href="#evidence-model" aria-label="Scroll to the evidence model"/);
  assert.match(landingSource, /href="\/api\/anchors">Anchor API/);
});

test("shared header keeps real home and dashboard navigation available", () => {
  assert.match(headerSource, /href="\/" aria-label="StellarCore home"/);
  assert.match(headerSource, /href="\/dashboard"/);
  assert.match(headerSource, /aria-current=\{current === "dashboard" \? "page" : undefined\}/);
  assert.doesNotMatch(
    globalStyles,
    /@media[^}]*max-width:\s*899px[\s\S]*?\.product-nav\s*\{[^}]*display:\s*none/,
  );
});

test("dashboard shell retains the four evidence sections and avoids live metadata claims", () => {
  for (const component of [
    "<AnchorsSection />",
    "<CorridorsSection />",
    "<RatePanel />",
    "<ReputationSection />",
  ]) {
    assert.equal(dashboardSource.includes(component), true, `missing ${component}`);
  }

  assert.match(dashboardSource, /<ProductHeader current="dashboard"/);
  assert.match(dashboardSource, /<EvidenceLegend \/>/);
  assert.doesNotMatch(dashboardSource, /description:\s*"[^"]*\blive\b/i);
});

test("successful persisted anchor synchronization is presented as synced, not live availability", () => {
  assert.match(
    anchorsSource,
    /case "LIVE":[\s\S]*?label: "Synced"/,
  );
  assert.doesNotMatch(anchorsSource, /label=\{anchor\.status\}/);
  assert.match(dashboardSource, /Status describes persisted synchronization state/);
  assert.match(dashboardSource, /not current operation or availability/);
});

test("a null median remains unavailable and explains the existing evidence requirement", () => {
  assert.match(ratePanelSource, /medianRate === null \? "Median unavailable" : medianRate/);
  assert.match(ratePanelSource, /fresh independent/);
  assert.match(ratePanelSource, /medianRequirement\.minimumFreshIndependentSources/);
  assert.doesNotMatch(ratePanelSource, /medianRate \?\? "—"/);
});

test("the pinned evidence cards pass beneath a dedicated readable glass layer", () => {
  assert.match(landingSource, /className="anchor-viewport"/);
  assert.match(landingSource, /className="anchors-glass" aria-hidden="true"/);
  assert.match(landingSource, /track\.scrollWidth - viewport\.clientWidth/);
  assert.match(globalStyles, /\.anchors-glass \{[^}]*rgba\(8,8,8,\.91\)[^}]*backdrop-filter: blur\(9px\)/);
  assert.match(globalStyles, /\.anchors-heading \{[^}]*z-index: 3;/);
  assert.match(globalStyles, /\.anchor-viewport \{[^}]*z-index: 1;[^}]*overflow: visible;/);
  assert.doesNotMatch(landingSource, /Inspect persisted evidence/);
});

test("custom cursor suppression remains scoped to the landing page", () => {
  assert.match(globalStyles, /\.landing-page,\s*\.landing-page a\s*\{\s*cursor:\s*none;/);
  assert.doesNotMatch(globalStyles, /(?:^|\})\s*(?:html|body|\*|a)\s*\{[^}]*cursor:\s*none;/m);
});

test("hero map receives the real reviewed corridor registry at the server boundary", () => {
  assert.match(homeSource, /import \{ CORRIDOR_REGISTRY \} from "@\/constants\/corridors"/);
  assert.match(homeSource, /<LandingPage reviewedCorridors=\{CORRIDOR_REGISTRY\} \/>/);
  assert.match(landingSource, /reviewedCorridors\.map\(corridorLabel\)/);
  assert.doesNotMatch(landingSource, /usdc-us-usd-us|ngnt-ng-ngn-ng|usdc-us-brl-br/);
});

test("hero map uses deterministic local Natural Earth geometry without a runtime fetch", () => {
  assert.match(landingSource, /WORLD_LAND_PATH/);
  assert.match(landingSource, /WORLD_GRATICULE_PATH/);
  assert.match(worldMapGeometrySource, /Natural Earth 1:110m land data/);
  assert.match(worldMapGeometrySource, /export const WORLD_LAND_PATH = "M/);
  assert.doesNotMatch(worldMapGeometrySource, /fetch\(|https?:\/\//);
});

test("hero map distinguishes reviewed geography without inventing live movement", () => {
  assert.match(landingSource, /corridor\.countryFrom === corridor\.countryTo/);
  assert.match(landingSource, /className="local-corridor"/);
  assert.match(landingSource, /className="corridor corridor-cross-country"/);
  assert.match(landingSource, /Persisted observations: dashboard only/);
  assert.match(landingSource, /Persisted observations are not[\s\S]*plotted/);
  assert.doesNotMatch(landingSource, /flow-dot|motionPath|corridor-echo|LIVE DATA/);
});
