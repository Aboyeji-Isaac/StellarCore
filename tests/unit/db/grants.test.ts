import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDatabaseGrantPlan,
  DatabaseGrantError,
  resolveGrantRoles,
  WRITER_TABLE_PRIVILEGES,
} from "@/lib/db/grants";

const ROLES = Object.freeze({ readerRole: "app_reader", writerRole: "app_writer" });
const TABLES = Object.freeze([...Object.keys(WRITER_TABLE_PRIVILEGES), "_prisma_migrations"]);

function plan(tables: readonly string[] = TABLES, sequences: readonly string[] = []) {
  return buildDatabaseGrantPlan({ ...ROLES, database: "app", tables, sequences });
}

test("the reader receives SELECT, USAGE, and CONNECT only", () => {
  const readerGrants = plan().filter((statement) =>
    statement.startsWith("GRANT") && statement.includes("\"app_reader\""));
  assert.ok(readerGrants.length > 0);
  for (const statement of readerGrants) {
    assert.match(statement, /^GRANT (SELECT|USAGE|CONNECT) ON /);
  }
  assert.equal(plan().some((statement) =>
    /TRUNCATE|GRANT CREATE|GRANT ALL|REFERENCES|TRIGGER/.test(statement)), false);
});

test("the writer receives exactly the reviewed DML matrix", () => {
  const statements = plan();
  assert.ok(statements.includes('GRANT INSERT ON TABLE "public"."rate_snapshots" TO "app_writer"'));
  assert.ok(statements.includes(
    'GRANT INSERT, DELETE ON TABLE "public"."anchor_corridors" TO "app_writer"',
  ));
  assert.equal(statements.some((statement) =>
    statement.startsWith("GRANT") && statement.includes('"transfer_outcomes"') &&
    !statement.startsWith("GRANT SELECT")), false);
  assert.equal(statements.some((statement) =>
    /GRANT [^"]*(UPDATE|DELETE)[^"]* ON TABLE "public"\."rate_snapshots"/.test(statement)), false);
});

test("migration metadata is revoked, not granted, to runtime roles", () => {
  const statements = plan().filter((statement) => statement.includes("_prisma_migrations"));
  assert.deepEqual(statements, [
    'REVOKE ALL ON TABLE "public"."_prisma_migrations" FROM "app_reader", "app_writer"',
  ]);
});

test("unreviewed tables default to SELECT only and sequences to writer usage", () => {
  const statements = plan(["future_table"], ["future_table_id_seq"]);
  assert.ok(statements.includes(
    'GRANT SELECT ON TABLE "public"."future_table" TO "app_reader", "app_writer"',
  ));
  assert.equal(statements.some((statement) => /GRANT (INSERT|UPDATE|DELETE)/.test(statement)), false);
  assert.ok(statements.includes(
    'GRANT USAGE, SELECT ON SEQUENCE "public"."future_table_id_seq" TO "app_writer"',
  ));
  assert.ok(statements.includes(
    'ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "app_reader", "app_writer"',
  ));
});

test("every run revokes before granting so re-applying is idempotent", () => {
  const statements = plan();
  for (const table of TABLES) {
    const revoke = statements.findIndex((statement) =>
      statement.startsWith("REVOKE ALL ON TABLE") && statement.includes(`"${table}"`));
    const grant = statements.findIndex((statement) =>
      statement.startsWith("GRANT") && statement.includes(`"${table}"`));
    assert.ok(revoke >= 0);
    assert.ok(grant === -1 || revoke < grant);
  }
  assert.deepEqual(plan(), plan());
});

test("role names are validated identifiers and must differ", () => {
  assert.deepEqual(resolveGrantRoles({}), {
    readerRole: "stellarcore_reader",
    writerRole: "stellarcore_writer",
  });
  for (const readerRole of ['bad"; DROP TABLE anchors; --', "Upper", "1bad"]) {
    assert.throws(
      () => resolveGrantRoles({ DATABASE_READ_ROLE: readerRole }),
      (error: unknown) => error instanceof DatabaseGrantError && error.code === "INVALID_ROLE_NAME",
    );
  }
  assert.throws(
    () => resolveGrantRoles({ DATABASE_READ_ROLE: "same", DATABASE_WRITE_ROLE: "same" }),
    (error: unknown) => error instanceof DatabaseGrantError && error.code === "ROLES_NOT_DISTINCT",
  );
});
