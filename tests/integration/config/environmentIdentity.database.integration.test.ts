import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_ENVIRONMENTS } from "@/lib/config/environment";
import {
  assertEnvironmentIdentity,
  resetEnvironmentIdentityCache,
} from "@/lib/config/environmentGuard";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_DATABASE_ENVIRONMENT_INTEGRATION === "1";

/**
 * Issue #143 acceptance: PostgreSQL integration tests cover every allowed and
 * forbidden environment pairing against the durable environment_identity row.
 * The test marks the real database for each environment in turn and asserts
 * the guard's decision, then restores the initial mark.
 */
test("every runtime/database environment pairing is enforced against the durable identity", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  await resetEnvironmentIdentityCache();

  const readMark = async (): Promise<string | null> => {
    const rows = await db.$queryRaw<{ environment: string | null }[]>`
      SELECT environment FROM environment_identity WHERE id = 1`;
    return rows[0]?.environment ?? null;
  };
  const markAs = async (environment: string | null) => {
    await db.$executeRaw`
      INSERT INTO environment_identity (id, environment, marked_at, note)
      VALUES (1, ${environment}, now(), 'environment integration test')
      ON CONFLICT (id) DO UPDATE
      SET environment = EXCLUDED.environment, marked_at = now(), note = EXCLUDED.note`;
  };

  const original = await readMark();
  try {
    for (const runtime of RUNTIME_ENVIRONMENTS) {
      process.env.STELLARCORE_ENVIRONMENT = runtime;
      for (const database of [...RUNTIME_ENVIRONMENTS, null] as const) {
        await markAs(database);
        await resetEnvironmentIdentityCache();
        const result = await assertEnvironmentIdentity();
        const allowed = database !== null && database === runtime;
        assert.equal(
          result.ok,
          allowed,
          `runtime=${runtime} database=${String(database)} expected ${allowed}`,
        );
        if (!allowed) {
          assert.equal(
            result.code,
            database === null ? "DATABASE_ENVIRONMENT_UNMARKED" : "DATABASE_ENVIRONMENT_MISMATCH",
          );
          assert.equal(
            (result.message ?? "").includes("postgres://"),
            false,
            "failure messages must never contain connection strings",
          );
        }
      }
    }
  } finally {
    await markAs(original);
    delete process.env.STELLARCORE_ENVIRONMENT;
    await resetEnvironmentIdentityCache();
    await db.$disconnect();
  }
});

/**
 * A preview runtime pointed at a production-marked database fails closed
 * before any evidence mutation: the guard rejects the connection itself.
 */
test("preview runtime against production-marked database fails closed before evidence mutation", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  await resetEnvironmentIdentityCache();

  await db.$executeRaw`
    INSERT INTO environment_identity (id, environment, marked_at, note)
    VALUES (1, 'production', now(), 'environment integration test')
    ON CONFLICT (id) DO UPDATE
    SET environment = 'production', marked_at = now(), note = EXCLUDED.note`;
  process.env.STELLARCORE_ENVIRONMENT = "preview";
  await resetEnvironmentIdentityCache();

  try {
    const result = await assertEnvironmentIdentity();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "DATABASE_ENVIRONMENT_MISMATCH");

    // The same pairing through the cron HTTP boundary must also fail closed.
    const { getScheduledRefreshResponse } = await import("@/lib/scheduled/http");
    const response = await getScheduledRefreshResponse(
      new Request("https://stellarcore.example/api/internal/cron/refresh", {
        headers: { authorization: "Bearer anything" },
      }),
      { cronSecret: "anything" },
    );
    assert.equal(response.status, 500);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "environment_identity_failure");
  } finally {
    delete process.env.STELLARCORE_ENVIRONMENT;
    await resetEnvironmentIdentityCache();
    await db.$disconnect();
  }
});
