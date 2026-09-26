import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRateChangeForAlert } from "@/lib/alerts/rateChangeEvaluator";
import type { RateAlertEvaluationInput } from "@/types/alerts";

const CORRIDOR = Object.freeze({
  slug: "usdc-us-brl-br",
  sourceAsset: "USDC",
  sourceCountry: "US",
  destinationAsset: "BRL",
  destinationCountry: "BR",
});

const NOW = new Date("2026-08-28T12:00:00.000Z");

test("first evaluation without prior history does not trigger alert", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: null,
    currentEvaluation: {
      state: "healthy",
      medianRate: "5.25",
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input);
  assert.equal(result.shouldAlert, false);
  if (!result.shouldAlert) {
    assert.equal(result.reason, "NO_PREVIOUS_EVALUATION");
  }
});

test("stale and insufficient sources on both evaluations never trigger false alert", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "insufficient_fresh_sources",
      medianRate: null,
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "insufficient_fresh_sources",
      medianRate: null,
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input);
  assert.equal(result.shouldAlert, false);
  if (!result.shouldAlert) {
    assert.equal(result.reason, "BOTH_INSUFFICIENT_SOURCES");
  }
});

test("transition from insufficient_fresh_sources to healthy triggers RATE_AVAILABLE", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "insufficient_fresh_sources",
      medianRate: null,
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "healthy",
      medianRate: "5.25",
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input);
  assert.equal(result.shouldAlert, true);
  if (result.shouldAlert) {
    assert.equal(result.changeType, "RATE_AVAILABLE");
    assert.equal(result.currentRate, "5.25");
    assert.equal(result.previousRate, null);
    assert.equal(result.currentState, "healthy");
    assert.equal(result.previousState, "insufficient_fresh_sources");
  }
});

test("transition from healthy to insufficient_fresh_sources triggers RATE_UNAVAILABLE", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "healthy",
      medianRate: "5.25",
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "insufficient_fresh_sources",
      medianRate: null,
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input);
  assert.equal(result.shouldAlert, true);
  if (result.shouldAlert) {
    assert.equal(result.changeType, "RATE_UNAVAILABLE");
    assert.equal(result.previousRate, "5.25");
    assert.equal(result.currentRate, null);
    assert.equal(result.currentState, "insufficient_fresh_sources");
    assert.equal(result.previousState, "healthy");
  }
});

test("rate movement below threshold does not alert", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "healthy",
      medianRate: "5.0000",
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "healthy",
      medianRate: "5.0200", // 0.4% change
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input, 1.0); // 1% threshold
  assert.equal(result.shouldAlert, false);
  if (!result.shouldAlert) {
    assert.equal(result.reason, "BELOW_THRESHOLD");
  }
});

test("rate movement at or above threshold triggers RATE_MOVEMENT", () => {
  const input: RateAlertEvaluationInput = {
    corridor: CORRIDOR,
    previousEvaluation: {
      state: "healthy",
      medianRate: "5.0000",
      evaluatedAt: new Date(NOW.getTime() - 60_000),
    },
    currentEvaluation: {
      state: "healthy",
      medianRate: "5.1000", // 2.0% change
      evaluatedAt: NOW,
    },
  };

  const result = evaluateRateChangeForAlert(input, 1.0);
  assert.equal(result.shouldAlert, true);
  if (result.shouldAlert) {
    assert.equal(result.changeType, "RATE_MOVEMENT");
    assert.equal(result.percentageChange, 2);
    assert.equal(result.previousRate, "5.0000");
    assert.equal(result.currentRate, "5.1000");
  }
});
