import assert from "node:assert/strict";
import test from "node:test";

import { deriveObservationKey } from "@/lib/rates/observationIdentity";

const BASE = Object.freeze({
  anchorSlug: "moneygram",
  corridorSlug: "usdc-us-usd-us",
  rate: "1.01",
  sourceAmount: "100",
  destinationAmount: "101",
  fee: "1",
  capturedAt: new Date("2026-08-27T12:00:00.000Z"),
});

test("the key is deterministic and a 64-character hex digest", () => {
  const key = deriveObservationKey(BASE);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(deriveObservationKey({ ...BASE }), key);
});

test("numerically equal decimals share a key", () => {
  assert.equal(
    deriveObservationKey({ ...BASE, rate: "1.010", sourceAmount: "100.0" }),
    deriveObservationKey(BASE),
  );
});

test("a different capture instant is a different observation despite equal numbers", () => {
  assert.notEqual(
    deriveObservationKey({ ...BASE, capturedAt: new Date("2026-08-27T12:00:00.001Z") }),
    deriveObservationKey(BASE),
  );
});

test("any differing source, corridor or value changes the key", () => {
  const key = deriveObservationKey(BASE);
  for (const change of [
    { anchorSlug: "other" },
    { corridorSlug: "usdc-us-ngn-ng" },
    { rate: "1.02" },
    { sourceAmount: "200" },
    { destinationAmount: "102" },
    { fee: "2" },
  ]) {
    assert.notEqual(deriveObservationKey({ ...BASE, ...change }), key);
  }
});

test("an upstream quote id fixes the identity regardless of capture time or values", () => {
  const first = deriveObservationKey({ ...BASE, upstreamQuoteId: "q-1" });
  const later = deriveObservationKey({
    ...BASE,
    rate: "9",
    capturedAt: new Date("2027-01-01T00:00:00.000Z"),
    upstreamQuoteId: "q-1",
  });
  assert.equal(later, first);
  assert.notEqual(deriveObservationKey({ ...BASE, upstreamQuoteId: "q-2" }), first);
  assert.notEqual(first, deriveObservationKey(BASE));
});
