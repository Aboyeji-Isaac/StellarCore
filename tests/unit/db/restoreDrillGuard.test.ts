import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVED_RESTORE_DRILL_ENVIRONMENTS,
  assertRestoreDrillTargetAllowed,
  guardRestoreDrillExecution,
  redactSensitiveDetails,
  resolveRestoreDrillTargetFromEnv,
  RestoreDrillTargetError,
  sanitizeDatabaseUrl,
  validateRestoreDrillTargetIdentity,
} from "@/lib/db/restoreDrillGuard";

test("approved restore drill environments include only isolated non-production targets", () => {
  assert.deepEqual(APPROVED_RESTORE_DRILL_ENVIRONMENTS, [
    "test",
    "ci",
    "isolated-drill",
    "restore-drill",
  ]);
  assert.equal(APPROVED_RESTORE_DRILL_ENVIRONMENTS.includes("production" as never), false);
  assert.equal(APPROVED_RESTORE_DRILL_ENVIRONMENTS.includes("preview" as never), false);
  assert.equal(APPROVED_RESTORE_DRILL_ENVIRONMENTS.includes("development" as never), false);
});

test("refuses configured production target identity before execution", () => {
  const productionIdentities = [
    "production",
    "Production",
    "PRODUCTION",
    "prod",
    "PROD",
    "live",
    "primary",
    "main",
  ];

  for (const identity of productionIdentities) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: identity,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "TARGET_IDENTITY_PRODUCTION");
    assert.match(verdict.reason, /prohibited from targeting production/i);

    assert.throws(
      () => assertRestoreDrillTargetAllowed({ targetEnvironment: identity }),
      (err: unknown) => {
        assert.ok(err instanceof RestoreDrillTargetError);
        assert.equal(err.code, "TARGET_IDENTITY_PRODUCTION");
        assert.match(err.message, /TARGET_IDENTITY_PRODUCTION/);
        return true;
      },
    );
  }
});

test("refuses missing target identity (fails closed)", () => {
  const missingCases: Array<string | null | undefined> = [
    undefined,
    null,
    "",
    "   ",
    "\t",
  ];

  for (const missing of missingCases) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: missing,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "TARGET_IDENTITY_MISSING");
    assert.match(verdict.reason, /missing/i);

    assert.throws(
      () => assertRestoreDrillTargetAllowed({ targetEnvironment: missing }),
      (err: unknown) => {
        assert.ok(err instanceof RestoreDrillTargetError);
        assert.equal(err.code, "TARGET_IDENTITY_MISSING");
        return true;
      },
    );
  }
});

test("refuses unapproved non-isolated target environments", () => {
  const unapproved = ["preview", "development", "staging", "qa", "sandbox", "unknown"];

  for (const env of unapproved) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: env,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "TARGET_IDENTITY_NOT_APPROVED");

    assert.throws(
      () => assertRestoreDrillTargetAllowed({ targetEnvironment: env }),
      (err: unknown) => {
        assert.ok(err instanceof RestoreDrillTargetError);
        assert.equal(err.code, "TARGET_IDENTITY_NOT_APPROVED");
        return true;
      },
    );
  }
});

test("accepts approved isolated test targets", () => {
  for (const env of APPROVED_RESTORE_DRILL_ENVIRONMENTS) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: env,
    });
    assert.equal(verdict.ok, true);
    if (verdict.ok) {
      assert.equal(verdict.targetEnvironment, env);
    }

    assert.doesNotThrow(() =>
      assertRestoreDrillTargetAllowed({ targetEnvironment: env }),
    );
  }
});

test("refuses production target database URLs even if environment is marked test", () => {
  const productionUrls = [
    "postgresql://user:pass@prod.db.internal:5432/testdb",
    "postgresql://user:pass@production-database.corp:5432/testdb",
    "postgresql://user:pass@db.live.stellarcore.org:5432/testdb",
    "postgresql://user:pass@primary-cluster.internal:5432/testdb",
    "postgresql://user:pass@app.supabase.co:5432/testdb",
    "postgresql://user:pass@ep-cool-db.neon.tech:5432/testdb",
    "postgresql://user:pass@stellarcore.c123456789.us-east-1.rds.amazonaws.com:5432/testdb",
    "postgresql://user:pass@localhost:5432/stellarcore_production",
    "postgresql://user:pass@localhost:5432/production",
    "postgresql://user:pass@127.0.0.1:5432/prod",
  ];

  for (const url of productionUrls) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: "test",
      targetDatabaseUrl: url,
    });
    assert.equal(verdict.ok, false);
    assert.ok(
      verdict.code === "TARGET_URL_PRODUCTION" ||
        verdict.code === "TARGET_DATABASE_PRODUCTION",
      `Expected production rejection for ${url}, got ${verdict.code}`,
    );

    assert.throws(
      () =>
        assertRestoreDrillTargetAllowed({
          targetEnvironment: "test",
          targetDatabaseUrl: url,
        }),
      (err: unknown) => {
        assert.ok(err instanceof RestoreDrillTargetError);
        return true;
      },
    );
  }
});

test("refuses non-loopback hosts without explicit authorization", () => {
  const nonLoopback = [
    "postgresql://user:pass@remote-staging.internal:5432/drill_db",
    "postgresql://user:pass@192.168.1.100:5432/drill_db",
    "postgresql://user:pass@10.0.0.5:5432/drill_db",
  ];

  for (const url of nonLoopback) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: "test",
      targetDatabaseUrl: url,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "TARGET_HOST_NOT_ISOLATED");
  }
});

test("accepts approved isolated loopback database URLs", () => {
  const approvedUrls = [
    "postgresql://postgres:pass@localhost:5432/stellarcore_restore",
    "postgresql://postgres:pass@127.0.0.1:5432/restore_drill",
    "postgresql://postgres:pass@[::1]:5432/isolated_test_db",
  ];

  for (const url of approvedUrls) {
    const verdict = validateRestoreDrillTargetIdentity({
      targetEnvironment: "isolated-drill",
      targetDatabaseUrl: url,
    });
    assert.equal(verdict.ok, true);
    assert.doesNotThrow(() =>
      assertRestoreDrillTargetAllowed({
        targetEnvironment: "isolated-drill",
        targetDatabaseUrl: url,
      }),
    );
  }
});

test("refuses target database carrying durable production stamp", () => {
  const verdict = validateRestoreDrillTargetIdentity({
    targetEnvironment: "test",
    databaseStamp: "production",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "DATABASE_STAMP_PRODUCTION");

  assert.throws(
    () =>
      assertRestoreDrillTargetAllowed({
        targetEnvironment: "test",
        databaseStamp: "production",
      }),
    (err: unknown) => {
      assert.ok(err instanceof RestoreDrillTargetError);
      assert.equal(err.code, "DATABASE_STAMP_PRODUCTION");
      return true;
    },
  );
});

test("failure output NEVER leaks credentials, passwords, or full connection URLs", () => {
  const secretPassword = "super_secret_high_entropy_password_987654";
  const secretToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload.signature";
  const rawUrlWithSecrets = `postgresql://db_admin_user:${secretPassword}@prod.database.internal:5432/stellarcore_prod?token=${secretToken}`;

  try {
    assertRestoreDrillTargetAllowed({
      targetEnvironment: "production",
      targetDatabaseUrl: rawUrlWithSecrets,
    });
    assert.fail("Should have thrown RestoreDrillTargetError");
  } catch (err: unknown) {
    assert.ok(err instanceof RestoreDrillTargetError);
    const message = (err as Error).message;

    // 1. Secret password must never appear in the error message
    assert.equal(message.includes(secretPassword), false);
    // 2. Secret token must never appear in the error message
    assert.equal(message.includes(secretToken), false);
    // 3. User credentials format (:password@) must never appear
    assert.equal(/:\w+@/.test(message), false);
    // 4. Raw connection URL with credentials must not be present
    assert.equal(message.includes(rawUrlWithSecrets), false);

    // Test JSON serialization of error
    const serialized = JSON.stringify(err);
    assert.equal(serialized.includes(secretPassword), false);
    assert.equal(serialized.includes(secretToken), false);

    // Test sanitizer directly
    const sanitized = sanitizeDatabaseUrl(rawUrlWithSecrets);
    assert.equal(sanitized.includes(secretPassword), false);
    assert.equal(sanitized.includes(secretToken), false);
    assert.match(sanitized, /^postgresql:\/\/\*\*\*@prod\.database\.internal:5432\/stellarcore_prod$/);

    // Test redactSensitiveDetails helper
    const textWithLeak = `Connection failed to ${rawUrlWithSecrets} with password=${secretPassword}`;
    const redactedText = redactSensitiveDetails(textWithLeak);
    assert.equal(redactedText.includes(secretPassword), false);
    assert.equal(redactedText.includes(secretToken), false);
  }
});

test("production target is rejected BEFORE any restore commands execute", async () => {
  let restoreCommandExecuted = false;

  const mockRestoreCommand = async () => {
    restoreCommandExecuted = true;
    return { restored: true };
  };

  // Case 1: Configured production target
  await assert.rejects(
    () =>
      guardRestoreDrillExecution(
        { targetEnvironment: "production" },
        mockRestoreCommand,
      ),
    (err: unknown) => {
      assert.ok(err instanceof RestoreDrillTargetError);
      assert.equal(err.code, "TARGET_IDENTITY_PRODUCTION");
      return true;
    },
  );
  assert.equal(
    restoreCommandExecuted,
    false,
    "Restore command MUST NOT execute when target identity is production",
  );

  // Case 2: Missing target identity
  await assert.rejects(
    () =>
      guardRestoreDrillExecution(
        { targetEnvironment: undefined },
        mockRestoreCommand,
      ),
    (err: unknown) => {
      assert.ok(err instanceof RestoreDrillTargetError);
      assert.equal(err.code, "TARGET_IDENTITY_MISSING");
      return true;
    },
  );
  assert.equal(
    restoreCommandExecuted,
    false,
    "Restore command MUST NOT execute when target identity is missing",
  );

  // Case 3: Approved test target executes successfully
  const result = await guardRestoreDrillExecution(
    { targetEnvironment: "isolated-drill" },
    mockRestoreCommand,
  );
  assert.equal(restoreCommandExecuted, true);
  assert.deepEqual(result, { restored: true });
});

test("resolves target configuration from environment variables correctly", () => {
  const env: Record<string, string> = {
    STELLARCORE_RESTORE_TARGET_ENVIRONMENT: "ci",
    RESTORE_TARGET_DATABASE_URL: "postgresql://postgres:pass@localhost:5432/restore_ci",
  };

  const resolved = resolveRestoreDrillTargetFromEnv(env);
  assert.equal(resolved.targetEnvironment, "ci");
  assert.equal(resolved.targetDatabaseUrl, env.RESTORE_TARGET_DATABASE_URL);

  const approved = assertRestoreDrillTargetAllowed(resolved);
  assert.equal(approved.targetEnvironment, "ci");
  assert.equal(approved.targetHost, "localhost");
});

test("test suite requires zero production secrets or live databases", () => {
  // Verifies that all assertions run purely in memory or with synthetic isolated targets
  assert.equal(process.env.PRODUCTION_DATABASE_URL, undefined);
  assert.equal(process.env.PROD_DATABASE_URL, undefined);
});
