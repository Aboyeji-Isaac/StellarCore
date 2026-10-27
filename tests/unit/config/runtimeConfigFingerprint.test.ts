import assert from "node:assert/strict";
import test from "node:test";

import { createTestRuntimeConfig } from "@/lib/config/runtimeConfig";
import {
  buildRuntimeConfigFingerprintMaterial,
  computeRuntimeConfigFingerprint,
  RuntimeConfigFingerprintError,
  verifyRuntimeConfigFingerprint,
} from "@/lib/config/runtimeConfigFingerprint";

test("runtime fingerprint is deterministic for equivalent configuration", () => {
  const config = createTestRuntimeConfig({
    environment: "production",
    databaseUrl: "postgresql://user:first-secret@db.example/core",
    cronSecret: "first-cron-secret",
  });

  assert.equal(
    computeRuntimeConfigFingerprint(config, "a".repeat(40)),
    computeRuntimeConfigFingerprint(config, "a".repeat(40)),
  );
});

test("secret values do not affect fingerprint when presence is unchanged", () => {
  const first = createTestRuntimeConfig({
    environment: "production",
    databaseUrl: "postgresql://user:first-secret@db.example/core",
    cronSecret: "first-cron-secret",
  });
  const second = createTestRuntimeConfig({
    environment: "production",
    databaseUrl: "postgresql://user:totally-different@db.example/core",
    cronSecret: "different-cron-secret",
  });

  const revision = "b".repeat(40);
  assert.equal(
    computeRuntimeConfigFingerprint(first, revision),
    computeRuntimeConfigFingerprint(second, revision),
  );

  const material = JSON.stringify(
    buildRuntimeConfigFingerprintMaterial(first, revision),
  );
  assert.equal(material.includes("first-secret"), false);
  assert.equal(material.includes("first-cron-secret"), false);
  assert.match(material, /"databaseUrl":true/);
  assert.match(material, /"cronSecret":true/);
});

test("non-secret policy changes and revision changes produce drift", () => {
  const base = createTestRuntimeConfig({
    environment: "production",
    rateFreshnessThresholdMs: 120_000,
    minFreshSources: 2,
  });
  const changed = createTestRuntimeConfig({
    environment: "production",
    rateFreshnessThresholdMs: 60_000,
    minFreshSources: 3,
  });

  assert.notEqual(
    computeRuntimeConfigFingerprint(base, "c".repeat(40)),
    computeRuntimeConfigFingerprint(changed, "c".repeat(40)),
  );
  assert.notEqual(
    computeRuntimeConfigFingerprint(base, "c".repeat(40)),
    computeRuntimeConfigFingerprint(base, "d".repeat(40)),
  );
});

test("matching expected fingerprint passes startup verification", () => {
  const config = createTestRuntimeConfig({ environment: "production" });
  const revision = "e".repeat(40);
  const expected = computeRuntimeConfigFingerprint(config, revision);

  const result = verifyRuntimeConfigFingerprint(config, {
    expectedFingerprint: expected,
    revision,
    policy: "fail",
  });

  assert.equal(result.bound, true);
  assert.equal(result.driftDetected, false);
  assert.equal(result.degraded, false);
});

test("production fail policy rejects missing and mismatched fingerprints", () => {
  const config = createTestRuntimeConfig({ environment: "production" });
  const revision = "f".repeat(40);

  assert.throws(
    () =>
      verifyRuntimeConfigFingerprint(config, {
        revision,
        policy: "fail",
      }),
    (error: unknown) =>
      error instanceof RuntimeConfigFingerprintError &&
      error.code === "EXPECTED_FINGERPRINT_MISSING",
  );

  assert.throws(
    () =>
      verifyRuntimeConfigFingerprint(config, {
        expectedFingerprint: "0".repeat(64),
        revision,
        policy: "fail",
      }),
    (error: unknown) =>
      error instanceof RuntimeConfigFingerprintError &&
      error.code === "RUNTIME_CONFIG_FINGERPRINT_MISMATCH",
  );
});

test("degrade policy reports drift without throwing", () => {
  const config = createTestRuntimeConfig({ environment: "production" });
  const result = verifyRuntimeConfigFingerprint(config, {
    expectedFingerprint: "0".repeat(64),
    revision: "1".repeat(40),
    policy: "degrade",
  });

  assert.equal(result.driftDetected, true);
  assert.equal(result.degraded, true);
});
