import assert from "node:assert/strict";
import test from "node:test";

import {
  isProductionLikeEnvironment,
  resolveDatabaseTlsPolicyForEnvironment,
} from "@/lib/database/tlsPolicyRuntime";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROD_URL = "postgres://user:secret@db.example.com:5432/stellar";

test("production runtime with a plain URL resolves verified TLS and a sanitized connection string", () => {
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: PROD_URL,
    environmentId: "production",
    environment: { DATABASE_URL: PROD_URL },
  });

  assert.equal(result.resolution.accepted, true);
  assert.ok(result.resolution.accepted && result.resolution.mode === "VERIFY_FULL");
  assert.ok(result.resolution.accepted && result.resolution.sslConfig.rejectUnauthorized === true);
  assert.equal(result.sanitizedConnectionString, PROD_URL);
  assert.equal(result.emergencyBypassActive, false);
});

test("production runtime with a bypass URL rejects with the safe diagnostic and keeps TLS parameters out of the connection string", () => {
  const bypassedUrl = `${PROD_URL}?ssl=no-verify&application_name=stellarcore`;
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: bypassedUrl,
    environmentId: "production",
    environment: { DATABASE_URL: bypassedUrl },
  });

  assert.equal(result.resolution.accepted, false);
  assert.ok(!result.resolution.accepted);
  const rejection = result.resolution.rejection;
  assert.equal(rejection.code, "PRODUCTION_TLS_VERIFICATION_BYPASS");
  assert.equal(JSON.stringify(rejection).includes("secret"), false);
  // The sanitized connection string removes the smuggling vector regardless.
  assert.equal(result.sanitizedConnectionString.includes("ssl=no-verify"), false);
  assert.equal(result.sanitizedConnectionString.includes("application_name=stellarcore"), true);
});

test("the emergency bypass gate activates only with the exact value and logs no credentials", () => {
  const bypassedUrl = `${PROD_URL}?ssl=no-verify`;

  const notGated = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: bypassedUrl,
    environmentId: "production",
    environment: { STELLARCORE_DB_TLS_EMERGENCY_BYPASS: "true" },
  });
  assert.equal(notGated.emergencyBypassActive, false);
  assert.equal(notGated.resolution.accepted, false);

  const gated = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: bypassedUrl,
    environmentId: "production",
    environment: {
      STELLARCORE_DB_TLS_EMERGENCY_BYPASS: "allow-unverified",
    },
  });
  assert.equal(gated.emergencyBypassActive, true);
  assert.equal(gated.resolution.accepted, true);
  assert.ok(gated.resolution.accepted && gated.resolution.mode === "NO_VERIFY");
});

test("development runtime keeps plaintext usable without policy interference", () => {
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: "postgres://user:secret@localhost:5432/stellar",
    environmentId: "development",
    environment: { DATABASE_URL: "postgres://user:secret@localhost:5432/stellar" },
  });

  assert.equal(result.resolution.accepted, true);
  assert.ok(result.resolution.accepted && result.resolution.mode === "DISABLED");
});

test("a configured CA file is loaded into the ssl config; its content never appears in diagnostics", () => {
  const caDir = mkdtempSync(join(tmpdir(), "stellarcore-ca-"));
  const caPath = join(caDir, "provider-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nPROVIDER-TEST-CA\n-----END CERTIFICATE-----\n");

  try {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: PROD_URL,
      environmentId: "production",
      environment: {
        STELLARCORE_DB_CA_PATH: caPath,
      },
    });

    assert.equal(result.resolution.accepted, true);
    assert.ok(result.resolution.accepted && result.resolution.mode === "VERIFY_FULL");
    assert.ok(
      result.resolution.accepted
      && typeof result.resolution.sslConfig.ca === "string"
      && result.resolution.sslConfig.ca.includes("PROVIDER-TEST-CA"),
    );
    // Diagnostics surface: rejection was not produced; nothing serialized
    // from this result contains CA content in a message field.
    assert.equal(JSON.stringify(result.sanitizedConnectionString).includes("PROVIDER-TEST-CA"), false);
  } finally {
    rmSync(caDir, { recursive: true, force: true });
  }
});

test("a configured missing CA file path fails closed in production", () => {
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: PROD_URL,
    environmentId: "production",
    environment: {
      STELLARCORE_DB_CA_PATH: "/nonexistent/path/ca.pem",
    },
  });

  assert.equal(result.resolution.accepted, false);
  assert.ok(
    !result.resolution.accepted &&
      result.resolution.rejection.code === "PRODUCTION_TLS_CA_MISSING",
  );
});

test("development exceptions cannot activate in production: same env map flips behavior by NODE_ENV only", () => {
  const devUrl = "postgres://user:secret@localhost:5432/stellar?sslmode=disable";

  const development = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: devUrl,
    environmentId: "development",
    environment: { DATABASE_URL: devUrl },
  });
  assert.equal(development.resolution.accepted, true);

  const production = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: devUrl,
    environmentId: "production",
    environment: { DATABASE_URL: devUrl },
  });
  assert.equal(production.resolution.accepted, false);
  assert.ok(!production.resolution.accepted && production.resolution.rejection.code === "PRODUCTION_TLS_DISABLED");
});
