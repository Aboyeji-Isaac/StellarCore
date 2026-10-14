import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyPgEnvironmentTls,
  classifyUrlTlsParameters,
  resolveDatabaseTlsPolicy,
  stripTlsParameters,
  TLS_EMERGENCY_BYPASS_VALUE,
  type TlsPolicyEnvironmentInput,
} from "@/lib/database/tlsPolicy";

const VERIFIED_URL = "postgres://user:secret@db.example.com:5432/stellar?connection_limit=5";

function productionInput(overrides: Partial<TlsPolicyEnvironmentInput> = {}): TlsPolicyEnvironmentInput {
  return {
    databaseUrl: VERIFIED_URL,
    isProductionLike: true,
    emergencyBypassRequested: false,
    inlineCa: null,
    caPath: null,
    caPathExists: false,
    ...overrides,
  };
}

test("production with an unconfigured URL is accepted with policy-owned verified TLS", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput());

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "VERIFY_FULL");
  assert.ok(resolution.accepted && resolution.sslConfig.rejectUnauthorized === true);
});

test("production rejects sslmode=disable", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?sslmode=disable",
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_DISABLED");
  assert.ok(!resolution.accepted && resolution.rejection.signal?.parameter === "sslmode");
});

test("production rejects ssl=0", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?ssl=0",
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_DISABLED");
});

for (const sslmode of ["require", "verify-ca", "allow"]) {
  test(`production upgrades sslmode=${sslmode} to policy-owned verified TLS`, () => {
    const url = `postgres://user:secret@db.example.com:5432/stellar?sslmode=${sslmode}&application_name=stellarcore`;
    const resolution = resolveDatabaseTlsPolicy(productionInput({ databaseUrl: url }));

    assert.equal(resolution.accepted, true);
    assert.ok(resolution.accepted && resolution.mode === "VERIFY_FULL");
    assert.ok(resolution.accepted && resolution.sslConfig.rejectUnauthorized === true);
    assert.equal(stripTlsParameters(url).includes("sslmode"), false);
    assert.equal(stripTlsParameters(url).includes("application_name=stellarcore"), true);
  });
}

test("production rejects ssl=no-verify outside the emergency gate", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?ssl=no-verify",
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_VERIFICATION_BYPASS");
});

test("ssl=no-verify with the exact emergency gate value resolves an explicit bypass", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?ssl=no-verify",
    emergencyBypassRequested: true,
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "NO_VERIFY");
  assert.ok(resolution.accepted && resolution.sslConfig.rejectUnauthorized === false);
});

test("the emergency gate requires the exact documented value", () => {
  for (const wrongValue of ["1", "true", "ALLOW-UNVERIFIED", "allow-unverified ", "yes"]) {
    assert.equal(wrongValue === TLS_EMERGENCY_BYPASS_VALUE, false, wrongValue);
  }
  assert.equal(TLS_EMERGENCY_BYPASS_VALUE, "allow-unverified");
});

test("production sslmode=disable is still rejected even with the emergency gate (no plaintext ever)", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?sslmode=disable",
    emergencyBypassRequested: true,
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_DISABLED");
});

test("an inline CA flows into the resolved ssl config and is never echoed in diagnostics", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
  const resolution = resolveDatabaseTlsPolicy(productionInput({ inlineCa: ca }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.sslConfig.rejectUnauthorized === true);
  assert.ok(resolution.accepted && resolution.sslConfig.ca === ca);
  assert.equal(JSON.stringify(resolution).includes("secret"), false);
});

test("development keeps plaintext usable when no TLS is configured", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    isProductionLike: false,
    databaseUrl: "postgres://user:secret@localhost:5432/stellar",
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "DISABLED");
});

test("classifies PG environment TLS settings", () => {
  assert.equal(classifyPgEnvironmentTls({ PGSSLMODE: "require" })?.mode, "REQUIRE");
  assert.equal(classifyUrlTlsParameters(VERIFIED_URL), null);
});
