import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNTIME_ENVIRONMENTS,
  checkEnvironmentIdentity,
  describeEnvironmentIdentityFailure,
  isPairingAllowed,
  resolveRuntimeIdentity,
  EnvironmentIdentityError,
  type DatabaseIdentity,
  type RuntimeEnvironment,
} from "@/lib/config/environment";

test("runtime identity requires an explicit declaration and rejects unknown values", () => {
  assert.throws(
    () => resolveRuntimeIdentity({}),
    (error: unknown) =>
      error instanceof EnvironmentIdentityError &&
      error.code === "RUNTIME_ENVIRONMENT_UNDECLARED",
  );
  assert.throws(
    () => resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "prod" }),
    (error: unknown) =>
      error instanceof EnvironmentIdentityError &&
      error.code === "RUNTIME_ENVIRONMENT_INVALID",
  );
  // Hostname must never be consulted: an identical hostname still fails.
  assert.throws(
    () => resolveRuntimeIdentity({ HOSTNAME: "stellarcore-production.vercel.app" }),
    (error: unknown) =>
      error instanceof EnvironmentIdentityError &&
      error.code === "RUNTIME_ENVIRONMENT_UNDECLARED",
  );
});

test("runtime identity defaults the expected database to the runtime itself", () => {
  const production = resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "production" });
  assert.equal(production.environment, "production");
  assert.equal(production.expectsDatabaseEnvironment, "production");

  const preview = resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "preview" });
  assert.equal(preview.expectsDatabaseEnvironment, "preview");

  const previewExplicit = resolveRuntimeIdentity({
    STELLARCORE_ENVIRONMENT: "preview",
    STELLARCORE_EXPECTED_DATABASE_ENVIRONMENT: "preview",
  });
  assert.equal(previewExplicit.expectsDatabaseEnvironment, "preview");
});

test("the pairing matrix allows only same-environment marks and fails closed on unknown", () => {
  for (const runtime of RUNTIME_ENVIRONMENTS) {
    for (const database of [...RUNTIME_ENVIRONMENTS, null]) {
      const expected = database !== null && database === runtime;
      assert.equal(
        isPairingAllowed(runtime, database),
        expected,
        `${runtime} vs ${String(database)}`,
      );
    }
  }
  // Production never falls back to an unmarked or differently marked database.
  assert.equal(isPairingAllowed("production", null), false);
  assert.equal(isPairingAllowed("production", "preview"), false);
  assert.equal(isPairingAllowed("production", "development"), false);
});

test("the typed check reports unmarked versus mismatched databases distinctly", () => {
  const runtime = resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "preview" });
  const unmarked: DatabaseIdentity = Object.freeze({ environment: null, markedAt: null });
  const mismatched: DatabaseIdentity = Object.freeze({
    environment: "production",
    markedAt: new Date(0),
  });

  const unmarkedCheck = checkEnvironmentIdentity(runtime, unmarked);
  assert.equal(unmarkedCheck.ok, false);
  if (!unmarkedCheck.ok) assert.equal(unmarkedCheck.code, "DATABASE_ENVIRONMENT_UNMARKED");

  const mismatchCheck = checkEnvironmentIdentity(runtime, mismatched);
  assert.equal(mismatchCheck.ok, false);
  if (!mismatchCheck.ok) assert.equal(mismatchCheck.code, "DATABASE_ENVIRONMENT_MISMATCH");

  // Failure descriptions are bounded and never include URLs or credentials.
  const message = describeEnvironmentIdentityFailure(mismatchCheck);
  assert.equal(message.includes("postgres"), false);
  assert.equal(message.includes("@"), false);
  assert.ok(message.length < 400);
});

test("a preview runtime pointed at a production-marked database fails closed before mutation", () => {
  const runtime = resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "preview" });
  const database: DatabaseIdentity = Object.freeze({
    environment: "production" as RuntimeEnvironment,
    markedAt: new Date(0),
  });
  const check = checkEnvironmentIdentity(runtime, database);
  assert.equal(check.ok, false);
});

test("production cannot be satisfied by preview or test marks", () => {
  const runtime = resolveRuntimeIdentity({ STELLARCORE_ENVIRONMENT: "production" });
  for (const mark of ["preview", "test", "ci", "development", null] as const) {
    const check = checkEnvironmentIdentity(runtime, {
      environment: mark,
      markedAt: mark ? new Date(0) : null,
    });
    assert.equal(check.ok, false, `production vs ${String(mark)}`);
  }
});
