import assert from "node:assert/strict";
import test from "node:test";

import {
  isIsoTimestampString,
  normalizePayload,
} from "@/lib/api/compatibility/normalizer";

test("isIsoTimestampString identifies valid ISO-8601 UTC strings only", () => {
  assert.equal(isIsoTimestampString("2026-08-28T12:00:00.000Z"), true);
  assert.equal(isIsoTimestampString("2026-01-01T00:00:00Z"), true);
  assert.equal(isIsoTimestampString("2026-12-31T23:59:59.999999Z"), true);

  // Invalid timestamps
  assert.equal(isIsoTimestampString("not-a-date"), false);
  assert.equal(isIsoTimestampString("2026-08-28"), false);
  assert.equal(isIsoTimestampString("2026-08-28 12:00:00"), false);
  assert.equal(isIsoTimestampString("2026-02-30T12:00:00.000Z"), false); // Invalid calendar date
  assert.equal(isIsoTimestampString(null), false);
  assert.equal(isIsoTimestampString(123456789), false);
  assert.equal(isIsoTimestampString({}), false);
});

test("normalizePayload normalizes ISO timestamps to <ISO_TIMESTAMP>", () => {
  const payload = {
    evaluatedAt: "2026-08-28T12:00:00.000Z",
    capturedAt: "2026-08-28T11:59:50.000Z",
    staticField: "hello world",
  };

  const normalized = normalizePayload(payload) as Record<string, unknown>;
  assert.equal(normalized["evaluatedAt"], "<ISO_TIMESTAMP>");
  assert.equal(normalized["capturedAt"], "<ISO_TIMESTAMP>");
  assert.equal(normalized["staticField"], "hello world");
});

test("normalizePayload does not mask invalid date strings", () => {
  const payload = {
    evaluatedAt: "invalid-timestamp-value",
  };

  const normalized = normalizePayload(payload) as Record<string, unknown>;
  assert.equal(normalized["evaluatedAt"], "invalid-timestamp-value");
});

test("normalizePayload normalizes ageMs numbers to <AGE_MS> when valid", () => {
  const valid = { ageMs: 15000 };
  const normalized = normalizePayload(valid) as Record<string, unknown>;
  assert.equal(normalized["ageMs"], "<AGE_MS>");

  // null ageMs is preserved
  const withNull = { ageMs: null };
  const normalizedNull = normalizePayload(withNull) as Record<string, unknown>;
  assert.equal(normalizedNull["ageMs"], null);

  // negative or float ageMs is not masked
  const withNegative = { ageMs: -1 };
  const normalizedNegative = normalizePayload(withNegative) as Record<string, unknown>;
  assert.equal(normalizedNegative["ageMs"], -1);
});

test("normalizePayload strictly preserves array ordering without sorting", () => {
  const original = ["zebra", "alpha", "beta"];
  const normalized = normalizePayload(original) as string[];
  assert.deepEqual(normalized, ["zebra", "alpha", "beta"]);
});

test("normalizePayload sorts object keys deterministically", () => {
  const unordered = { z: 1, a: 2, m: 3 };
  const normalized = normalizePayload(unordered) as Record<string, unknown>;
  assert.deepEqual(Object.keys(normalized), ["a", "m", "z"]);
});
