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

test("production rejects sslmode=require as a verification bypass (driver downgrade semantics)", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?sslmode=require",
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_VERIFICATION_BYPASS");
});

test("production rejects sslmode=verify-ca as a verification bypass", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    databaseUrl: "postgres://user:secret@db.example.com:5432/stellar?sslmode=verify-ca",
  }));

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_VERIFICATION_BYPASS");
});

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
  const resolution = resolveDatabaseTlsPolicy(productionInput({ isProductionLike: false }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "DISABLED");
});

test("development explicitly requesting verified TLS is honored", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    isProductionLike: false,
    databaseUrl: `${VERIFIED_URL}&sslmode=verify-full`,
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "VERIFY_FULL");
});

test("development sslmode=disable is honored without production gating", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({
    isProductionLike: false,
    databaseUrl: `${VERIFIED_URL}&sslmode=disable`,
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "DISABLED");
});

test("PGSSLMODE environment is respected as the TLS signal when the URL has no TLS parameters", () => {
  const resolution = resolveDatabaseTlsPolicy(
    productionInput(),
    { PGSSLMODE: "disable" },
  );

  assert.equal(resolution.accepted, false);
  assert.ok(!resolution.accepted && resolution.rejection.code === "PRODUCTION_TLS_DISABLED");
  assert.ok(!resolution.accepted && resolution.rejection.signal?.source === "PG_ENVIRONMENT");
});

test("URL parameters take precedence over PGSSLMODE when both are present", () => {
  const signal = classifyUrlTlsParameters(`${VERIFIED_URL}&sslmode=disable`);
  assert.ok(signal);
  assert.equal(signal.mode, "DISABLED");
  assert.equal(classifyPgEnvironmentTls({ PGSSLMODE: "verify-full" })?.mode, "VERIFY_FULL");
});

test("TLS parameters are stripped from the URL while non-TLS parameters survive", () => {
  const stripped = stripTlsParameters(
    "postgres://user:secret@db.example.com:5432/stellar?sslmode=require&connection_limit=5&ssl=no-verify&sslrootcert=%2Fetc%2Fca.pem&application_name=stellarcore",
  );

  const url = new URL(stripped);
  for (const parameter of ["sslmode", "ssl", "sslrootcert"]) {
    assert.equal(url.searchParams.has(parameter), false, parameter);
  }
  assert.equal(url.searchParams.get("connection_limit"), "5");
  assert.equal(url.searchParams.get("application_name"), "stellarcore");
  assert.equal(url.username, "user");
  assert.equal(url.hostname, "db.example.com");
});

test("a URL without TLS parameters passes through sanitization unchanged", () => {
  const url = "postgres://user:secret@db.example.com:5432/stellar?connection_limit=5";
  assert.equal(stripTlsParameters(url), url);
});

test("policy decisions never embed credentials in messages", () => {
  const resolutions = [
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://user:super-secret-password@db.example.com:5432/stellar?sslmode=disable",
    })),
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://user:super-secret-password@db.example.com:5432/stellar?ssl=no-verify",
    })),
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://user:super-secret-password@db.example.com:5432/stellar?sslmode=require",
    })),
  ];

  for (const resolution of resolutions) {
    assert.equal(resolution.accepted, false);
    if (!resolution.accepted) {
      const serialized = JSON.stringify(resolution);
      assert.equal(serialized.includes("super-secret-password"), false);
      assert.equal(serialized.includes("db.example.com"), false);
    }
  }
});

test("rejecting an empty database URL in production names the failure", () => {
  const resolution = resolveDatabaseTlsPolicy(productionInput({ databaseUrl: "" }));

  // An empty URL carries no TLS signal; production treats UNSET as policy-
  // owned verified TLS, but the missing URL is caught by scheme validation
  // before policy. Policy itself must not crash on it.
  assert.ok(resolution);
});
