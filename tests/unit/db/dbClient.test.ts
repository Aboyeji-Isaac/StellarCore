import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";

const {
  evictStaleConnections,
  getDatabasePool,
  validateDatabaseUrl,
} = await import("@/lib/dbClient");

test("validateDatabaseUrl requires defined string", () => {
  assert.throws(
    () => validateDatabaseUrl(undefined),
    /DATABASE_URL is not defined/,
  );
  assert.throws(
    () => validateDatabaseUrl(""),
    /DATABASE_URL is not defined/,
  );
});

test("validateDatabaseUrl requires valid URL", () => {
  assert.throws(
    () => validateDatabaseUrl("not-a-url"),
    /DATABASE_URL must be a valid PostgreSQL connection URL/,
  );
});

test("validateDatabaseUrl rejects unsupported protocols", () => {
  assert.throws(
    () => validateDatabaseUrl("prisma://user:pass@host/db"),
    /DATABASE_URL must use postgres:\/\/ or postgresql:\/\/ with PrismaPg/,
  );
  assert.throws(
    () => validateDatabaseUrl("prisma+postgres://user:pass@host/db"),
    /DATABASE_URL must use postgres:\/\/ or postgresql:\/\/ with PrismaPg/,
  );
  assert.throws(
    () => validateDatabaseUrl("http://localhost:5432/db"),
    /DATABASE_URL must use postgres:\/\/ or postgresql:\/\//,
  );
});

test("validateDatabaseUrl accepts postgres:// and postgresql://", () => {
  const url1 = "postgres://user:pass@localhost:5432/db";
  const url2 = "postgresql://user:pass@localhost:5432/db";

  assert.equal(validateDatabaseUrl(url1), url1);
  assert.equal(validateDatabaseUrl(url2), url2);
});

test("getDatabasePool and evictStaleConnections return operational objects", () => {
  const pool = getDatabasePool();
  assert.ok(pool);
  assert.equal(typeof pool.connect, "function");

  const evicted = evictStaleConnections();
  assert.equal(typeof evicted, "number");
  assert.ok(evicted >= 0);
});
