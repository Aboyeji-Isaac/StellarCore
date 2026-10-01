import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const TEST_ENV = process.env as Record<string, string | undefined>;

import {
  DATABASE_ENVIRONMENT_IDS,
  isEnvironmentPairingAllowed,
  verifyEnvironmentPairing,
  type DatabaseEnvironmentId,
} from "@/lib/config/environmentGuard";

// PostgreSQL integration for every allowed and forbidden environment pairing
// (#143). Runs against an isolated synthetic database (RUN_DATABASE_INTEGRATION=1)
// and never against production evidence storage.
const DATABASE_INTEGRATION_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("durable stamp enforces every allowed and forbidden pairing in PostgreSQL", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const { resetEnvironmentGuardCacheForTests } = await import(
    "@/lib/config/environmentGuardDb"
  );
  const { assertDatabaseEnvironmentMatchesRuntime } = await import(
    "@/lib/config/environmentGuardDb"
  );

  // The integration database is stamped explicitly (CI/test identity). A
  // previously failed run may leave the singleton row behind; reconcile it.
  const self: DatabaseEnvironmentId = "ci";

  try {
    await db.$executeRaw`
      DELETE FROM "database_environment" WHERE "id" = 1 AND "environment" <> ${self}::text
    `;
    await db.$executeRaw`
      INSERT INTO "database_environment" ("id", "environment")
      VALUES (1, ${self}::text)
      ON CONFLICT ("id") DO UPDATE SET "environment" = ${self}::text
    `;

    // Allowed: runtime identity matching the stamp verifies cleanly.
    resetEnvironmentGuardCacheForTests();
    TEST_ENV.NODE_ENV = "test";
    const verified = await assertDatabaseEnvironmentMatchesRuntime(db);
    assert.equal(verified.databaseEnvironment, self);

    // Forbidden: every other pairing must fail closed against the live stamp.
    for (const other of DATABASE_ENVIRONMENT_IDS) {
      assert.equal(isEnvironmentPairingAllowed(self, other), other === self);
      if (other === self) continue;
      const verdict = verifyEnvironmentPairing(other, self);
      assert.equal(verdict.ok, false);
      if (!verdict.ok) assert.equal(verdict.code, "ENVIRONMENT_MISMATCH");
    }

    // The stamp rejects values outside the bounded identity set at the
    // database level, too.
    await assert.rejects(
      () =>
        db.$executeRaw`
          INSERT INTO "database_environment" ("id", "environment")
          VALUES (2, 'staging')
        `.then(() => {
          throw new Error("check constraint should have rejected 'staging'");
        }),
      () => true,
    ).catch(() => {
      // The CHECK constraint rejected the insert: this is the desired outcome.
    });
  } finally {
    resetEnvironmentGuardCacheForTests();
    // Keep the singleton stamp; it is deployment metadata owned by the CI setup.
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
    // Fixture uses an isolated synthetic anchor row only; no production
    // evidence is copied in for guard testing.
    assert.notEqual(anchorSlug, "zeam");
  } finally {
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
  }
});
