import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_REFRESH_FAILURE_ENTRIES,
  RefreshRunTransitionError,
  assertLegalPhaseTransition,
  assertLegalRunTransition,
  resolveTerminalRunState,
  sanitizeRefreshFailures,
} from "@/lib/scheduled/refreshRunState";

test("legal phase transitions are allowed and every illegal transition is rejected", () => {
  assert.doesNotThrow(() => assertLegalPhaseTransition("PENDING", "RUNNING"));
  assert.doesNotThrow(() => assertLegalPhaseTransition("PENDING", "SKIPPED"));
  assert.doesNotThrow(() => assertLegalPhaseTransition("RUNNING", "SUCCEEDED"));
  assert.doesNotThrow(() => assertLegalPhaseTransition("RUNNING", "FAILED"));
  assert.doesNotThrow(() => assertLegalPhaseTransition("FAILED", "RUNNING"));

  for (const [from, to] of [
    ["PENDING", "SUCCEEDED"],
    ["PENDING", "FAILED"],
    ["RUNNING", "RUNNING"],
    ["SUCCEEDED", "RUNNING"],
    ["SUCCEEDED", "FAILED"],
    ["SKIPPED", "RUNNING"],
  ] as const) {
    assert.throws(() => assertLegalPhaseTransition(from, to), RefreshRunTransitionError);
  }
});

test("terminal run states are final and only RUNNING may transition", () => {
  assert.doesNotThrow(() => assertLegalRunTransition("RUNNING", "SUCCEEDED"));
  assert.doesNotThrow(() => assertLegalRunTransition("RUNNING", "PARTIALLY_SUCCEEDED"));
  assert.doesNotThrow(() => assertLegalRunTransition("RUNNING", "FAILED"));
  for (const from of ["SUCCEEDED", "PARTIALLY_SUCCEEDED", "FAILED"] as const) {
    assert.throws(() => assertLegalRunTransition(from, "RUNNING"), RefreshRunTransitionError);
  }
});

test("a run is successful only when every required phase succeeded", () => {
  assert.equal(resolveTerminalRunState({ rates: "SUCCEEDED", reputation: "SUCCEEDED" }), "SUCCEEDED");
  assert.equal(resolveTerminalRunState({ rates: "SUCCEEDED", reputation: "FAILED" }), "PARTIALLY_SUCCEEDED");
  assert.equal(resolveTerminalRunState({ rates: "FAILED", reputation: "SUCCEEDED" }), "PARTIALLY_SUCCEEDED");
  assert.equal(resolveTerminalRunState({ rates: "FAILED", reputation: "FAILED" }), "FAILED");
  assert.equal(resolveTerminalRunState({ rates: "PENDING", reputation: "FAILED" }), "FAILED");
  assert.equal(resolveTerminalRunState({ rates: "SKIPPED", reputation: "SUCCEEDED" }), "PARTIALLY_SUCCEEDED");
  assert.equal(resolveTerminalRunState({ rates: "SKIPPED", reputation: "SKIPPED" }), "FAILED");
});

test("failure sanitization keeps only bounded whitelisted fields and drops secrets and stacks", () => {
  const sanitized = sanitizeRefreshFailures([
    {
      phase: "rates",
      code: "QUOTE_FAILURE",
      anchorSlug: "zeam",
      corridorSlug: "usdc-us-brl-br",
      message: "DATABASE_URL=postgres://user:pass@host/db",
      stack: "Error: boom\n  at /app/secret.ts:1:1",
      authorization: "Bearer super-secret-token",
      rawBody: "<html>remote error</html>",
    },
    "not-an-object",
    null,
    { phase: "reputation", code: "EVIDENCE_READ_FAILURE", anchorSlug: "moneygram" },
  ]);

  assert.deepEqual(sanitized, [
    { phase: "rates", code: "QUOTE_FAILURE", anchorSlug: "zeam", corridorSlug: "usdc-us-brl-br" },
    { phase: "reputation", code: "EVIDENCE_READ_FAILURE", anchorSlug: "moneygram" },
  ]);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes("super-secret-token"), false);
  assert.equal(serialized.includes("secret.ts"), false);
  assert.equal(serialized.includes("postgres://"), false);
});

test("failure sanitization truncates unsafe field values and caps the number of entries", () => {
  const [withUnsafeCode] = sanitizeRefreshFailures([
    { phase: "rates code drop table", code: "not a safe code", anchorSlug: "bad slug!" },
  ]);
  assert.equal(withUnsafeCode?.phase, "UNKNOWN_PHASE");
  assert.equal(withUnsafeCode?.code, "UNKNOWN_FAILURE_CODE");
  assert.equal(withUnsafeCode?.anchorSlug, undefined);

  const [longSlug] = sanitizeRefreshFailures([
    { phase: "rates", code: "QUOTE_FAILURE", anchorSlug: "a".repeat(200) },
  ]);
  assert.equal(longSlug?.anchorSlug?.length, 120);

  const bounded = sanitizeRefreshFailures(
    Array.from({ length: MAX_REFRESH_FAILURE_ENTRIES + 25 }, () => ({
      phase: "rates",
      code: "QUOTE_FAILURE",
    })),
  );
  assert.equal(bounded.length, MAX_REFRESH_FAILURE_ENTRIES);
});
