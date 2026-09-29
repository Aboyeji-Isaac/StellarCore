import assert from "node:assert/strict";
import test from "node:test";

import {
  DatabaseConfigurationError,
  resolveRuntimeDatabaseUrl,
} from "@/lib/db/connection";

const READ = "postgresql://stellarcore_reader:reader-secret@db.example.com:5432/app";
const WRITE = "postgresql://stellarcore_writer:writer-secret@db.example.com:5432/app";
const OWNER = "postgresql://stellarcore_owner:owner-secret@db.example.com:5432/app";

function assertConfigurationError(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DatabaseConfigurationError);
    assert.equal(error.code, code);
    for (const secret of ["reader-secret", "writer-secret", "owner-secret", "db.example.com"]) {
      assert.equal(error.message.includes(secret), false, "error message leaks connection details");
    }
    return true;
  });
}

test("each runtime role resolves only its own URL", () => {
  const env = { DATABASE_READ_URL: READ, DATABASE_WRITE_URL: WRITE };
  assert.equal(resolveRuntimeDatabaseUrl("read", env), READ);
  assert.equal(resolveRuntimeDatabaseUrl("write", env), WRITE);
});

test("a missing read URL fails closed instead of falling back to a more privileged URL", () => {
  assertConfigurationError(() => resolveRuntimeDatabaseUrl("read", {
    DATABASE_WRITE_URL: WRITE,
    MIGRATION_DATABASE_URL: OWNER,
    DATABASE_URL: OWNER,
  }), "DATABASE_URL_MISSING");
});

test("a missing write URL fails closed instead of falling back to the migration owner", () => {
  assertConfigurationError(() => resolveRuntimeDatabaseUrl("write", {
    DATABASE_READ_URL: READ,
    MIGRATION_DATABASE_URL: OWNER,
    DATABASE_URL: OWNER,
  }), "DATABASE_URL_MISSING");
});

test("invalid and unsupported URLs fail with bounded errors", () => {
  assertConfigurationError(
    () => resolveRuntimeDatabaseUrl("read", { DATABASE_READ_URL: "reader-secret not a url" }),
    "DATABASE_URL_INVALID",
  );
  assertConfigurationError(
    () => resolveRuntimeDatabaseUrl("read", {
      DATABASE_READ_URL: "mysql://u:reader-secret@db.example.com/app",
    }),
    "DATABASE_URL_UNSUPPORTED_PROTOCOL",
  );
  assertConfigurationError(
    () => resolveRuntimeDatabaseUrl("write", {
      DATABASE_WRITE_URL: "prisma+postgres://db.example.com/?api_key=writer-secret",
    }),
    "DATABASE_URL_UNSUPPORTED_PROTOCOL",
  );
});

test("a production runtime refuses migration and legacy owner credentials", () => {
  for (const forbidden of ["MIGRATION_DATABASE_URL", "DATABASE_URL"]) {
    assertConfigurationError(() => resolveRuntimeDatabaseUrl("read", {
      NODE_ENV: "production",
      DATABASE_READ_URL: READ,
      DATABASE_WRITE_URL: WRITE,
      [forbidden]: OWNER,
    }), "DATABASE_PRIVILEGED_URL_IN_RUNTIME");
  }
});

test("a production runtime refuses one database user for both runtime roles", () => {
  assertConfigurationError(() => resolveRuntimeDatabaseUrl("write", {
    NODE_ENV: "production",
    DATABASE_READ_URL: WRITE.replace("writer-secret", "reader-secret"),
    DATABASE_WRITE_URL: WRITE,
  }), "DATABASE_ROLES_NOT_SEPARATED");
  assert.equal(resolveRuntimeDatabaseUrl("write", {
    NODE_ENV: "production",
    DATABASE_READ_URL: READ,
    DATABASE_WRITE_URL: WRITE,
  }), WRITE);
});
