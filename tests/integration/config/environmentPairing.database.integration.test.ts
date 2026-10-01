import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const TEST_ENV = process.env as Record<string, string | undefined>;

import {
  DATABASE_ENVIRONMENT_IDS,
} from "@/lib/config/environmentGuard";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("durable stamp enforces every allowed and forbidden pairing in PostgreSQL", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const {
    assertDatabaseEnvironmentMatchesRuntime,
    resetEnvironmentGuardCacheForTests,
  } = await import("@/lib/config/environmentGuardDb");

  const previousExplicit = TEST_ENV.STELLARCORE_ENVIRONMENT;

  try {
    for (const databaseEnvironment of DATABASE_ENVIRONMENT_IDS) {
      await db.$executeRaw`
        INSERT INTO "database_environment" ("id", "environment")
        VALUES (1, ${databaseEnvironment}::text)
        ON CONFLICT ("id") DO UPDATE SET "environment" = ${databaseEnvironment}::text
      `;

      for (const runtimeEnvironment of DATABASE_ENVIRONMENT_IDS) {
        TEST_ENV.STELLARCORE_ENVIRONMENT = runtimeEnvironment;
        resetEnvironmentGuardCacheForTests();

        if (runtimeEnvironment === databaseEnvironment) {
          const verified = await assertDatabaseEnvironmentMatchesRuntime(db);
          assert.deepEqual(verified, { runtimeEnvironment, databaseEnvironment });
        } else {
          await assert.rejects(
            () => assertDatabaseEnvironmentMatchesRuntime(db),
            (error: unknown) => {
              assert.equal(
                (error as { code?: unknown }).code,
                "ENVIRONMENT_MISMATCH",
                `${runtimeEnvironment} -> ${databaseEnvironment}`,
              );
              return true;
            },
          );
        }
      }
    }

    await assert.rejects(() =>
      db.$executeRaw`
        UPDATE "database_environment"
        SET "environment" = 'staging'
        WHERE "id" = 1
      `,
    );
  } finally {
    resetEnvironmentGuardCacheForTests();
    if (previousExplicit === undefined) delete TEST_ENV.STELLARCORE_ENVIRONMENT;
    else TEST_ENV.STELLARCORE_ENVIRONMENT = previousExplicit;
  }
});

test("synthetic fixture rows never leak into shared state", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-env-isolation-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Environment Isolation Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
      },
      select: { id: true },
    });
    assert.ok(anchor.id);
    assert.notEqual(anchorSlug, "zeam");
  } finally {
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
  }
});
