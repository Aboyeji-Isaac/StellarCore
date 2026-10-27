import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSensitiveFields,
  RateSourceProvenanceError,
  sanitizeEndpointUrl,
  validateRateSourceProvenance,
} from "@/lib/rates/provenance";

const VALID_DIGEST = "a".repeat(64);
const VALID_PROVENANCE = Object.freeze({
  sourceType: "sep38",
  anchorSlug: "zeam",
  corridorSlug: "usdc-us-brl-br",
  endpointUrl: "https://api.zeam.example/sep38/prices",
  configurationDigest: VALID_DIGEST,
  requestShapeVersion: "v1",
  capturedAt: "2026-10-19T10:00:00.000Z",
});

test("accepts valid normalized provenance without secret fields", () => {
  const result = validateRateSourceProvenance(VALID_PROVENANCE);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provenance.sourceType, "sep38");
    assert.equal(result.provenance.anchorSlug, "zeam");
    assert.equal(result.provenance.corridorSlug, "usdc-us-brl-br");
    assert.equal(result.provenance.endpointUrl, "https://api.zeam.example/sep38/prices");
    assert.equal(result.provenance.configurationDigest, VALID_DIGEST);
    assert.equal(result.provenance.requestShapeVersion, "v1");
    assert.equal(result.provenance.capturedAt, "2026-10-19T10:00:00.000Z");
  }
});

test("accepts optional captureRunId when valid", () => {
  const result = validateRateSourceProvenance({
    ...VALID_PROVENANCE,
    captureRunId: "run_20261019_abc123",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provenance.captureRunId, "run_20261019_abc123");
  }
});

test("accepts Date object for capturedAt and serializes to ISO string", () => {
  const date = new Date("2026-10-19T10:00:00.000Z");
  const result = validateRateSourceProvenance({
    ...VALID_PROVENANCE,
    capturedAt: date,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.provenance.capturedAt, "2026-10-19T10:00:00.000Z");
  }
});

test("rejects credential-bearing URLs in endpointUrl", () => {
  const credentialUrls = [
    "https://user:pass@api.example.com/sep38",
    "http://admin:secret123@api.example.com/prices",
    "https://api.example.com/sep38?token=secret123456",
    "https://api.example.com/sep38?apiKey=topsecret",
    "https://api.example.com/sep38?secret=supersecret",
    "https://api.example.com/sep38?password=hidden",
  ];

  for (const url of credentialUrls) {
    const result = validateRateSourceProvenance({
      ...VALID_PROVENANCE,
      endpointUrl: url,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "CREDENTIAL_BEARING_URL");
    }
    assert.throws(
      () => sanitizeEndpointUrl(url),
      (err: Error) => err instanceof RateSourceProvenanceError && err.code === "CREDENTIAL_BEARING_URL",
    );
  }
});

test("rejects prohibited sensitive field names anywhere in the payload", () => {
  const sensitivePayloads = [
    { ...VALID_PROVENANCE, token: "bearer-token-123" },
    { ...VALID_PROVENANCE, secret: "confidential-secret" },
    { ...VALID_PROVENANCE, password: "mypassword" },
    { ...VALID_PROVENANCE, api_key: "api-key-value" },
    { ...VALID_PROVENANCE, apiKey: "api-key-value" },
    { ...VALID_PROVENANCE, authorization: "Bearer mysecret" },
    { ...VALID_PROVENANCE, private_key: "-----BEGIN PRIVATE KEY-----" },
    { ...VALID_PROVENANCE, nested: { secret: "deeply-nested-secret" } },
    { ...VALID_PROVENANCE, headers: [{ authorization: "secret" }] },
  ];

  for (const payload of sensitivePayloads) {
    const result = validateRateSourceProvenance(payload);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "PROHIBITED_SENSITIVE_FIELD");
    }
  }
});

test("rejects sensitive value patterns (Bearer, JWT, database URL) even with innocent keys", () => {
  const sensitiveValues = [
    "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
    "postgresql://postgres:secretpassword@localhost:5432/db",
    "https://user:password@endpoint.com/feed",
  ];

  for (const val of sensitiveValues) {
    const result = validateRateSourceProvenance({
      ...VALID_PROVENANCE,
      requestShapeVersion: val,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.code === "PROHIBITED_SENSITIVE_FIELD" ||
        result.code === "INVALID_REQUEST_SHAPE_VERSION",
      );
    }
  }
});

test("error messages and failure results NEVER reveal supplied secret values", () => {
  const superSecretValue = "ultra_sensitive_classified_token_9999999";
  const payloadWithSecret = {
    ...VALID_PROVENANCE,
    token: superSecretValue,
  };

  const result = validateRateSourceProvenance(payloadWithSecret);
  assert.equal(result.ok, false);
  if (!result.ok) {
    // The code should be deterministic
    assert.equal(result.code, "PROHIBITED_SENSITIVE_FIELD");
    // Ensure serialization does not contain the secret
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(superSecretValue), false);
  }

  // Also test direct assertion
  try {
    assertNoSensitiveFields({ key: superSecretValue });
    assert.fail("Should have thrown");
  } catch (err: unknown) {
    assert.ok(err instanceof RateSourceProvenanceError);
    assert.equal(err.code, "PROHIBITED_SENSITIVE_FIELD");
    assert.equal((err as Error).message.includes(superSecretValue), false);
  }
});

test("validates configurationDigest format strictly (64-char hex)", () => {
  const invalidDigests = [
    "too-short",
    "g".repeat(64), // non-hex
    "a".repeat(63),
    "a".repeat(65),
    "",
  ];

  for (const digest of invalidDigests) {
    const result = validateRateSourceProvenance({
      ...VALID_PROVENANCE,
      configurationDigest: digest,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "INVALID_CONFIGURATION_DIGEST");
    }
  }
});

test("rejects invalid slugs and source types", () => {
  assert.equal(
    validateRateSourceProvenance({ ...VALID_PROVENANCE, sourceType: "sep6" }).ok,
    false,
  );
  assert.equal(
    validateRateSourceProvenance({ ...VALID_PROVENANCE, anchorSlug: "INVALID_SLUG!" }).ok,
    false,
  );
  assert.equal(
    validateRateSourceProvenance({ ...VALID_PROVENANCE, corridorSlug: "" }).ok,
    false,
  );
  assert.equal(
    validateRateSourceProvenance({ ...VALID_PROVENANCE, capturedAt: "not-a-date" }).ok,
    false,
  );
});

test("sanitizes valid endpointUrl correctly", () => {
  assert.equal(
    sanitizeEndpointUrl("https://api.example.com/sep38/prices"),
    "https://api.example.com/sep38/prices",
  );
  assert.equal(
    sanitizeEndpointUrl("https://api.example.com:8443/quotes?format=json"),
    "https://api.example.com:8443/quotes?format=json",
  );
});
