import assert from "node:assert/strict";
import test from "node:test";

import {
  computeWebhookSignature,
  generateSubscriptionSecret,
  verifyWebhookSignature,
} from "@/lib/alerts/signature";

test("generateSubscriptionSecret produces 64-char hex strings", () => {
  const secret1 = generateSubscriptionSecret();
  const secret2 = generateSubscriptionSecret();

  assert.equal(secret1.length, 64);
  assert.equal(secret2.length, 64);
  assert.notEqual(secret1, secret2);
});

test("compute and verify signature matches correctly", () => {
  const secret = generateSubscriptionSecret();
  const payload = JSON.stringify({ event: "corridor.rate_change", rate: "5.25" });
  const timestamp = Date.now();

  const signature = computeWebhookSignature(payload, secret, timestamp);
  assert.equal(typeof signature, "string");
  assert.equal(signature.length, 64);

  const isValid = verifyWebhookSignature(payload, secret, timestamp, signature);
  assert.equal(isValid, true);

  const isValidWithPrefix = verifyWebhookSignature(
    payload,
    secret,
    timestamp,
    `sha256=${signature}`,
  );
  assert.equal(isValidWithPrefix, true);
});

test("tampered payload or wrong secret fails verification", () => {
  const secret = generateSubscriptionSecret();
  const payload = JSON.stringify({ event: "corridor.rate_change", rate: "5.25" });
  const timestamp = Date.now();
  const signature = computeWebhookSignature(payload, secret, timestamp);

  assert.equal(
    verifyWebhookSignature("tampered payload", secret, timestamp, signature),
    false,
  );

  const wrongSecret = generateSubscriptionSecret();
  assert.equal(
    verifyWebhookSignature(payload, wrongSecret, timestamp, signature),
    false,
  );

  assert.equal(
    verifyWebhookSignature(payload, secret, timestamp + 1000, signature),
    false,
  );
});
