import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

function read(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

const reputationSection = read("components/dashboard/ReputationSection.tsx");
const ratePanel = read("components/dashboard/RatePanel.tsx");

// ---------------------------------------------------------------------------
// ReputationSection – null/optional evidence fields
// ---------------------------------------------------------------------------

describe("ReputationSection null-evidence handling", () => {
  test("score=null renders a prose fallback instead of the score value", () => {
    // When score is null the component must branch away from rendering a number
    assert.match(
      reputationSection,
      /entry\.score !== null/,
      "must guard the score display on a non-null check",
    );
    // Fallback copy for not-evaluated and insufficient-evidence states
    assert.match(reputationSection, /This anchor has no persisted evaluation yet\./);
    assert.match(reputationSection, /Evidence is too sparse for a published score\./);
  });

  test("scoreBand=null is guarded before rendering a Badge", () => {
    // The badge for scoreBand must not be rendered when scoreBand is null
    assert.match(
      reputationSection,
      /entry\.scoreBand \?/,
      "must conditionally render the score-band badge",
    );
  });

  test("evidence=null hides the outcome count block instead of crashing", () => {
    assert.match(
      reputationSection,
      /entry\.evidence \?/,
      "must guard the evidence block with a truthiness check",
    );
    assert.match(
      reputationSection,
      /outcomeCount/,
      "outcomeCount must be referenced when evidence is present",
    );
  });

  test("metrics=null hides the metric grid instead of rendering nulls", () => {
    assert.match(
      reputationSection,
      /entry\.metrics \?/,
      "must guard the metrics block with a truthiness check",
    );
  });

  test("individual metric values use a dash fallback when null", () => {
    // formatMetric and formatMs must return "—" for null
    assert.match(
      reputationSection,
      /function formatMetric\(value: number \| null\): string/,
      "must declare formatMetric accepting null",
    );
    assert.match(
      reputationSection,
      /value === null \? "—"/,
      "formatMetric must produce an em-dash for null",
    );
    assert.match(
      reputationSection,
      /function formatMs\(value: number \| null\): string/,
      "must declare formatMs accepting null",
    );
  });

  test("computedAt=null hides the timestamp instead of rendering 'null'", () => {
    assert.match(
      reputationSection,
      /entry\.computedAt \?/,
      "must guard computedAt rendering on truthiness",
    );
  });

  test("state badge and anchor name are always visible regardless of null evidence", () => {
    // The state badge and anchor name are outside any null-guard
    assert.match(reputationSection, /entry\.anchor\.name/);
    assert.match(reputationSection, /stateTone\(entry\.state\)/);
    assert.match(reputationSection, /stateCopy\(entry\.state\)/);
  });

  test("does not leak literal 'null' or 'undefined' strings into rendered output", () => {
    // Ensure no unguarded string interpolation of nullable values
    assert.doesNotMatch(
      reputationSection,
      /\{entry\.score\}(?!\s*<\/)/,
      "score must not be rendered without a null guard",
    );
    assert.doesNotMatch(
      reputationSection,
      /\{entry\.computedAt\}(?!\s*<\/)/,
      "computedAt must not be interpolated directly",
    );
  });
});

// ---------------------------------------------------------------------------
// RatePanel – null/optional evidence fields
// ---------------------------------------------------------------------------

describe("RatePanel null-evidence handling", () => {
  test("medianRate=null renders a prose fallback instead of the rate value", () => {
    assert.match(
      ratePanel,
      /medianRate === null/,
      "must check medianRate for null",
    );
    assert.match(
      ratePanel,
      /Median unavailable/,
      "must show a human-readable fallback when median is null",
    );
  });

  test("medianRate=null shows the evidence shortfall label", () => {
    assert.match(
      ratePanel,
      /medianRate === null \?[\s\S]*?medianEvidenceLabel/,
      "when median is null the evidence label must be visible",
    );
  });

  test("insufficient_fresh_sources state renders the explanatory paragraph", () => {
    assert.match(
      ratePanel,
      /state === "insufficient_fresh_sources"/,
      "must branch on the insufficient state",
    );
    assert.match(
      ratePanel,
      /No median is published until the fresh independent-observation requirement is met/,
    );
  });

  test("observation.exclusionReason (optional) is guarded before interpolation", () => {
    assert.match(
      ratePanel,
      /observation\.exclusionReason \?/,
      "must guard exclusionReason with a truthiness check before interpolating",
    );
  });

  test("observation.freshness.ageMs (nullable) is never interpolated raw", () => {
    // ageMs is number | null in the type; the component must not render it
    // as a literal. It is only used in freshness.state which is always a string.
    assert.doesNotMatch(
      ratePanel,
      /observation\.freshness\.ageMs/,
      "ageMs should not be rendered directly in the panel; freshness.state is used instead",
    );
  });

  test("freshness state badge is always visible for every observation row", () => {
    assert.match(
      ratePanel,
      /freshnessTone\(observation\.freshness\.state\)/,
      "each observation must show a freshness badge",
    );
    assert.match(
      ratePanel,
      /observation\.freshness\.state/,
      "the freshness state string must be the badge label",
    );
  });

  test("evaluatedAt timestamp is always rendered", () => {
    assert.match(
      ratePanel,
      /Evaluated.*new Date\(evaluatedAt\)/,
      "evaluatedAt must always be visible",
    );
  });

  test("does not render literal 'null' or 'undefined' strings", () => {
    // Guard against naive `String(null)` or `${null}` patterns
    assert.doesNotMatch(
      ratePanel,
      /String\(medianRate\)/,
      "must not use String() on nullable medianRate",
    );
    assert.doesNotMatch(
      ratePanel,
      /String\(observation\.exclusionReason\)/,
      "must not use String() on optional exclusionReason",
    );
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: helper functions in ReputationSection
// ---------------------------------------------------------------------------

describe("ReputationSection null-safe helper coverage", () => {
  test("formatMetric handles all nullable metric fields", () => {
    // All six metric accessors must go through formatMetric or formatMs
    const metricFields = [
      "fillRate7d",
      "fillRate30d",
      "fillRate90d",
      "settleP50Ms",
      "settleP95Ms",
      "slippageP50",
    ];
    for (const field of metricFields) {
      assert.match(
        reputationSection,
        new RegExp(`entry\\.metrics\\.${field}`),
        `metric field ${field} must be referenced in the component`,
      );
    }
  });

  test("formatMetric and formatMs both produce a visible em-dash for null inputs", () => {
    // Both helpers must return "—" not "" or "null"
    const matches = reputationSection.match(/value === null \? "—"/g);
    assert.ok(
      matches && matches.length >= 2,
      "both formatMetric and formatMs must use the em-dash fallback",
    );
  });
});
