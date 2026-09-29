import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "pg";

import { applyDatabaseGrants } from "@/lib/db/grants";

/**
 * Proves the PostgreSQL privilege boundaries against a real server. The test
 * creates a throwaway database and three synthetic LOGIN roles, applies the
 * committed migrations as the synthetic owner, applies the reviewed grant
 * plan, and exercises allowed and denied operations with synthetic fixtures.
 * It never touches production evidence and drops everything it created.
 *
 * Opt-in: RUN_DATABASE_ROLE_INTEGRATION=1 and DATABASE_ROLE_TEST_ADMIN_URL,
 * a role with CREATEDB and CREATEROLE on an isolated PostgreSQL server.
 */
const ENABLED = process.env.RUN_DATABASE_ROLE_INTEGRATION === "1";
const ADMIN_URL = process.env.DATABASE_ROLE_TEST_ADMIN_URL;
const INSUFFICIENT_PRIVILEGE = "42501";
const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const PRISMA_CLI = createRequire(import.meta.url).resolve("prisma/build/index.js");

const suffix = randomBytes(6).toString("hex");
const names = Object.freeze({
  database: `stellarcore_roles_${suffix}`,
  owner: `sc_owner_${suffix}`,
  reader: `sc_reader_${suffix}`,
  writer: `sc_writer_${suffix}`,
});
const passwords = Object.freeze({
  owner: randomBytes(18).toString("hex"),
  reader: randomBytes(18).toString("hex"),
  writer: randomBytes(18).toString("hex"),
});

const FIXTURE = Object.freeze({
  anchorSlug: `role-fixture-anchor-${suffix}`,
  corridorSlug: `role-fixture-corridor-${suffix}`,
  writerAnchorSlug: `role-writer-anchor-${suffix}`,
  writerCorridorSlug: `role-writer-corridor-${suffix}`,
});

function roleUrl(role: keyof typeof passwords): string {
  const url = new URL(ADMIN_URL as string);
  url.username = names[role];
  url.password = passwords[role];
  url.pathname = `/${names.database}`;
  return url.href;
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url, application_name: "stellarcore-role-test" });
  await client.connect();
  return client;
}

async function withClient<T>(url: string, run: (client: Client) => Promise<T>): Promise<T> {
  const client = await connect(url);
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function assertDenied(client: Client, sql: string): Promise<void> {
  await assert.rejects(client.query(sql), (error: { code?: string }) => {
    assert.equal(error.code, INSUFFICIENT_PRIVILEGE, `expected permission denial for: ${sql}`);
    return true;
  });
}

function runMigrations(configPath?: string): void {
  const args = [PRISMA_CLI, "migrate", "deploy"];
  if (configPath) args.push("--config", configPath);
  const result = spawnSync(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, MIGRATION_DATABASE_URL: roleUrl("owner") },
  });
  // Output is not echoed: it is bounded to the exit status on failure.
  assert.equal(result.status, 0, "prisma migrate deploy failed as the synthetic owner");
}

type GrantRow = Readonly<{ grantee: string; table_name: string; privilege_type: string }>;

async function grantSnapshot(client: Client): Promise<readonly GrantRow[]> {
  return (await client.query<GrantRow>(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = ANY($1::text[])
      ORDER BY grantee, table_name, privilege_type`,
    [[names.reader, names.writer]],
  )).rows;
}

async function evidenceSnapshot(client: Client): Promise<unknown> {
  const tables = ["anchors", "corridors", "anchor_corridors", "rate_snapshots",
    "transfer_outcomes", "reputation_scores"];
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    snapshot[table] = (await client.query(
      `SELECT to_jsonb(row) AS value FROM "${table}" AS row ORDER BY to_jsonb(row)::text`,
    )).rows;
  }
  return snapshot;
}

describe("least-privilege PostgreSQL roles", { skip: !ENABLED }, () => {
  let admin: Client;

  before(async () => {
    assert.ok(ADMIN_URL, "DATABASE_ROLE_TEST_ADMIN_URL is required");
    admin = await connect(ADMIN_URL);
    for (const role of ["owner", "reader", "writer"] as const) {
      await admin.query(
        `CREATE ROLE "${names[role]}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${passwords[role]}'`,
      );
    }
    await admin.query(`CREATE DATABASE "${names.database}" OWNER "${names.owner}"`);
    // Portable across PostgreSQL versions whose public schema owner differs.
    const adminOnDatabase = new URL(ADMIN_URL);
    adminOnDatabase.pathname = `/${names.database}`;
    await withClient(adminOnDatabase.href, (client) =>
      client.query(`ALTER SCHEMA public OWNER TO "${names.owner}"`));

    runMigrations();

    await withClient(roleUrl("owner"), async (owner) => {
      const anchor = (await owner.query<{ id: string }>(
        `INSERT INTO anchors (slug, name, home_domain, toml_url, status, is_transfer_capable, seps, updated_at)
         VALUES ($1, 'Role Fixture Anchor', 'fixture.example.com',
                 'https://fixture.example.com/.well-known/stellar.toml', 'LIVE', true, '{1,24,38}', now())
         RETURNING id`,
        [FIXTURE.anchorSlug],
      )).rows[0];
      const corridor = (await owner.query<{ id: string }>(
        `INSERT INTO corridors (slug, asset_code_from, country_from, asset_code_to, country_to)
         VALUES ($1, 'USDC', 'US', 'BRL', 'BR') RETURNING id`,
        [FIXTURE.corridorSlug],
      )).rows[0];
      await owner.query(
        "INSERT INTO anchor_corridors (anchor_id, corridor_id) VALUES ($1, $2)",
        [anchor.id, corridor.id],
      );
      await owner.query(
        `INSERT INTO rate_snapshots (anchor_id, corridor_id, rate, source_amount, destination_amount, fee, captured_at)
         VALUES ($1, $2, 5.1, 100, 510, 0.5, now())`,
        [anchor.id, corridor.id],
      );
      await owner.query(
        `INSERT INTO transfer_outcomes (anchor_id, corridor_id, status, fill_rate, settlement_ms, slippage)
         VALUES ($1, $2, 'COMPLETED', 1, 1000, 0)`,
        [anchor.id, corridor.id],
      );

      const evidenceBefore = await evidenceSnapshot(owner);
      await applyDatabaseGrants(owner, { readerRole: names.reader, writerRole: names.writer });
      const firstGrants = await grantSnapshot(owner);
      await applyDatabaseGrants(owner, { readerRole: names.reader, writerRole: names.writer });
      assert.deepEqual(await grantSnapshot(owner), firstGrants, "grant plan is idempotent");
      assert.deepEqual(await evidenceSnapshot(owner), evidenceBefore, "grants preserve evidence");
    });

    process.env.DATABASE_READ_URL = roleUrl("reader");
    process.env.DATABASE_WRITE_URL = roleUrl("writer");
    delete process.env.DATABASE_URL;
    delete process.env.MIGRATION_DATABASE_URL;
  });

  after(async () => {
    const clients = globalThis as unknown as {
      stellarCoreReadDb?: { $disconnect: () => Promise<void> };
      stellarCoreWriteDb?: { $disconnect: () => Promise<void> };
    };
    await clients.stellarCoreReadDb?.$disconnect();
    await clients.stellarCoreWriteDb?.$disconnect();
    if (!admin) return;
    await admin.query(`DROP DATABASE IF EXISTS "${names.database}" WITH (FORCE)`);
    for (const role of ["reader", "writer", "owner"] as const) {
      await admin.query(`DROP ROLE IF EXISTS "${names[role]}"`);
    }
    await admin.end();
  });

  test("public API and dashboard repositories succeed with the SELECT-only reader", async () => {
    const { readDb } = await import("@/lib/db/readClient");
    const [session] = await readDb.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
    assert.equal(session.user, names.reader);

    const { getAnchorsApiResult, getAnchorApiResult } = await import("@/lib/api/anchors");
    const { getCorridorsApiResult } = await import("@/lib/api/corridors");
    const { getReputationApiResult } = await import("@/lib/api/reputation");
    const { readLatestCorridorRate } = await import("@/lib/rates/latestRateReadModel");

    const anchors = await getAnchorsApiResult();
    assert.equal(anchors.status, 200);
    assert.equal((await getAnchorApiResult(FIXTURE.anchorSlug)).status, 200);
    assert.equal((await getCorridorsApiResult()).status, 200);
    assert.equal((await getReputationApiResult()).status, 200);
    const latest = await readLatestCorridorRate(FIXTURE.corridorSlug);
    assert.equal(latest.ok, true);
  });

  test("the reader cannot insert, update, delete, truncate, create, alter, or drop", async () => {
    await withClient(roleUrl("reader"), async (reader) => {
      await assertDenied(reader, `INSERT INTO corridors (slug, asset_code_from, country_from, asset_code_to, country_to)
        VALUES ('denied', 'USDC', 'US', 'USD', 'US')`);
      await assertDenied(reader, "UPDATE anchors SET name = 'tampered'");
      await assertDenied(reader, "DELETE FROM rate_snapshots");
      await assertDenied(reader, "TRUNCATE rate_snapshots");
      await assertDenied(reader, "INSERT INTO reputation_scores (anchor_id) SELECT id FROM anchors LIMIT 1");
      await assertDenied(reader, "CREATE TABLE public.reader_table (id int)");
      await assertDenied(reader, "ALTER TABLE anchors ADD COLUMN tampered text");
      await assertDenied(reader, "DROP TABLE rate_snapshots");
      await assertDenied(reader, `CREATE SCHEMA reader_schema_${suffix}`);
      await assertDenied(reader, "SELECT * FROM _prisma_migrations");
    });
  });

  test("approved mutation paths succeed with the writer without owner privileges", async () => {
    const { writeDb } = await import("@/lib/db/writeClient");
    const [session] = await writeDb.$queryRaw<{ user: string }[]>`SELECT current_user AS "user"`;
    assert.equal(session.user, names.writer);

    const { persistDiscoveredAnchor, markAnchorDownIfExists } = await import("@/lib/stellar/anchorSync");
    const { persistCorridor, persistAnchorCorridorAssociations } = await import("@/lib/stellar/corridorSync");
    const { persistRateSnapshot } = await import("@/lib/rates/snapshot");
    const { evaluateAnchorReputation } = await import("@/lib/reputation/engine");

    await persistDiscoveredAnchor({
      slug: FIXTURE.writerAnchorSlug,
      name: "Role Writer Anchor",
      homeDomain: "writer.example.com",
      tomlUrl: "https://writer.example.com/.well-known/stellar.toml",
      organizationName: "Role Writer Anchor",
      networkPassphrase: "Test SDF Network ; September 2015",
      seps: [1, 38],
      isTransferCapable: true,
      endpoints: {},
      assets: [],
    });
    await persistCorridor({
      slug: FIXTURE.writerCorridorSlug,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "MXN",
      countryTo: "MX",
    });
    await persistAnchorCorridorAssociations({
      anchorSlug: FIXTURE.writerAnchorSlug,
      corridorSlugs: [FIXTURE.writerCorridorSlug],
    });
    // Reconciliation removes an association no longer in the reviewed set.
    await persistAnchorCorridorAssociations({
      anchorSlug: FIXTURE.writerAnchorSlug,
      corridorSlugs: [FIXTURE.corridorSlug],
    });
    const snapshot = await persistRateSnapshot({
      anchorSlug: FIXTURE.writerAnchorSlug,
      corridorSlug: FIXTURE.corridorSlug,
      rate: "5.2",
      sourceAmount: "100",
      destinationAmount: "520",
      fee: "0.4",
      capturedAt: new Date(),
    });
    assert.equal(snapshot.ok, true);
    const reputation = await evaluateAnchorReputation(FIXTURE.writerAnchorSlug);
    assert.equal(reputation.ok, true);
    assert.equal(await markAnchorDownIfExists(FIXTURE.writerAnchorSlug), true);
  });

  test("the writer cannot run DDL or rewrite evidence outside its reviewed grants", async () => {
    await withClient(roleUrl("writer"), async (writer) => {
      await assertDenied(writer, "CREATE TABLE public.writer_table (id int)");
      await assertDenied(writer, "ALTER TABLE anchors ADD COLUMN tampered text");
      await assertDenied(writer, "DROP TABLE reputation_scores");
      await assertDenied(writer, "CREATE INDEX writer_index ON anchors (name)");
      await assertDenied(writer, `CREATE SCHEMA writer_schema_${suffix}`);
      await assertDenied(writer, "TRUNCATE rate_snapshots");
      await assertDenied(writer, "UPDATE rate_snapshots SET rate = 0");
      await assertDenied(writer, "DELETE FROM rate_snapshots");
      await assertDenied(writer, "DELETE FROM anchors");
      await assertDenied(writer, "DELETE FROM reputation_scores");
      await assertDenied(writer, `INSERT INTO transfer_outcomes (anchor_id, corridor_id, status, fill_rate, settlement_ms, slippage)
        SELECT anchor_id, corridor_id, 'COMPLETED', 1, 1, 0 FROM anchor_corridors LIMIT 1`);
      await assertDenied(writer, "SELECT * FROM _prisma_migrations");
    });
  });

  test("tables and sequences created by a later migration receive default grants", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "stellarcore-role-migration-"));
    try {
      const migrations = join(workspace, "migrations");
      cpSync(join(REPOSITORY_ROOT, "prisma/migrations"), migrations, { recursive: true });
      const futureMigration = join(migrations, "29990101000000_role_test_future_table");
      mkdirSync(futureMigration);
      writeFileSync(join(futureMigration, "migration.sql"),
        "CREATE TABLE \"future_evidence\" (\"id\" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \"note\" TEXT NOT NULL);\n");
      const configPath = join(workspace, "prisma.config.mjs");
      writeFileSync(configPath, [
        "export default {",
        `  schema: ${JSON.stringify(join(REPOSITORY_ROOT, "prisma/schema.prisma"))},`,
        `  migrations: { path: ${JSON.stringify(migrations)} },`,
        "  datasource: { url: process.env.MIGRATION_DATABASE_URL },",
        "};",
      ].join("\n"));

      runMigrations(configPath);

      await withClient(roleUrl("owner"), async (owner) => {
        const { rows: [privileges] } = await owner.query(
          `SELECT has_table_privilege($1, 'future_evidence', 'SELECT') AS reader_select,
                  has_table_privilege($1, 'future_evidence', 'INSERT') AS reader_insert,
                  has_table_privilege($2, 'future_evidence', 'SELECT') AS writer_select,
                  has_table_privilege($2, 'future_evidence', 'INSERT') AS writer_insert,
                  has_table_privilege($2, 'future_evidence', 'UPDATE') AS writer_update,
                  has_table_privilege($2, 'future_evidence', 'DELETE') AS writer_delete,
                  has_sequence_privilege($1, 'future_evidence_id_seq', 'USAGE') AS reader_sequence,
                  has_sequence_privilege($2, 'future_evidence_id_seq', 'USAGE') AS writer_sequence,
                  (SELECT tableowner FROM pg_tables WHERE tablename = 'future_evidence') AS table_owner`,
          [names.reader, names.writer],
        );
        assert.deepEqual(privileges, {
          reader_select: true,
          reader_insert: false,
          writer_select: true,
          writer_insert: false,
          writer_update: false,
          writer_delete: false,
          reader_sequence: false,
          writer_sequence: true,
          table_owner: names.owner,
        });
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
