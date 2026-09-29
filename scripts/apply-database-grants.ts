import "dotenv/config";

import { pathToFileURL } from "node:url";

import { Client } from "pg";

import { MIGRATION_DATABASE_URL_ENV } from "@/lib/db/connection";
import {
  applyDatabaseGrants,
  buildDatabaseGrantPlan,
  DatabaseGrantError,
  resolveGrantRoles,
  WRITER_TABLE_PRIVILEGES,
} from "@/lib/db/grants";

/**
 * Applies the reviewed least-privilege grant plan (lib/db/grants.ts) as the
 * migration owner. `--print` prints the plan for the reviewed table set
 * without connecting to any database. Output never includes credentials.
 */
async function main(): Promise<void> {
  const roles = resolveGrantRoles();

  if (process.argv.includes("--print")) {
    const statements = buildDatabaseGrantPlan({
      ...roles,
      database: "<current database>",
      tables: Object.keys(WRITER_TABLE_PRIVILEGES),
      sequences: [],
    });
    console.log(statements.map((statement) => `${statement};`).join("\n"));
    return;
  }

  const connectionString = process.env[MIGRATION_DATABASE_URL_ENV];
  if (!connectionString) {
    console.error(JSON.stringify({ ok: false, code: "MIGRATION_DATABASE_URL_MISSING" }));
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    connectionString,
    application_name: "stellarcore-grants",
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });

  try {
    await client.connect();
    const result = await applyDatabaseGrants(client, roles);
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } catch (error) {
    // Only bounded, credential-free codes are printed.
    console.error(JSON.stringify(error instanceof DatabaseGrantError
      ? { ok: false, code: error.code, message: error.message }
      : { ok: false, code: "GRANT_FAILURE" }));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch(() => {
    console.error(JSON.stringify({ ok: false, code: "GRANT_FAILURE" }));
    process.exitCode = 1;
  });
}
