/**
 * Reviewed PostgreSQL privilege model for StellarCore.
 *
 * Three privilege classes exist:
 * - migration owner: the role behind MIGRATION_DATABASE_URL. It owns every
 *   application object, runs `prisma migrate deploy`, and applies this plan.
 *   It is never configured for the deployed runtime.
 * - internal writer (DATABASE_WRITE_URL): SELECT on application tables plus
 *   only the DML listed in WRITER_TABLE_PRIVILEGES. It owns nothing and
 *   cannot run DDL.
 * - public reader (DATABASE_READ_URL): SELECT on application tables only.
 *
 * The plan is idempotent: every run revokes both runtime roles' privileges on
 * the application schema's objects and re-grants exactly this matrix inside
 * one transaction. It never touches table rows and never stores credentials;
 * roles and their passwords are provisioned outside the repository.
 */

export const APPLICATION_SCHEMA = "public";
export const PRISMA_MIGRATIONS_TABLE = "_prisma_migrations";
export const DEFAULT_READ_ROLE = "stellarcore_reader";
export const DEFAULT_WRITE_ROLE = "stellarcore_writer";
export const READ_ROLE_ENV = "DATABASE_READ_ROLE";
export const WRITE_ROLE_ENV = "DATABASE_WRITE_ROLE";

export type WriterTablePrivilege = "INSERT" | "UPDATE" | "DELETE";

/**
 * DML the writer needs beyond SELECT, per table, derived from the approved
 * mutation paths. Evidence tables stay append-only for the writer: rate
 * snapshots are inserted, never updated or deleted, and transfer outcomes are
 * not written at all until outcome ingestion exists.
 */
export const WRITER_TABLE_PRIVILEGES: Readonly<
  Record<string, readonly WriterTablePrivilege[]>
> = Object.freeze({
  // lib/stellar/anchorSync.ts: upsert discovered anchors, mark anchors DOWN.
  anchors: Object.freeze(["INSERT", "UPDATE"] as const),
  // lib/stellar/corridorSync.ts: upsert reviewed corridors.
  corridors: Object.freeze(["INSERT", "UPDATE"] as const),
  // lib/stellar/corridorSync.ts: reconcile reviewed associations.
  anchor_corridors: Object.freeze(["INSERT", "DELETE"] as const),
  // lib/rates/snapshot.ts: append indicative quote evidence.
  rate_snapshots: Object.freeze(["INSERT"] as const),
  // lib/reputation/repository.ts: upsert the current score per anchor.
  reputation_scores: Object.freeze(["INSERT", "UPDATE"] as const),
  // Read by reputation evaluation; no approved writer path exists yet.
  transfer_outcomes: Object.freeze([] as const),
});

export type DatabaseGrantErrorCode =
  | "INVALID_ROLE_NAME"
  | "ROLES_NOT_DISTINCT"
  | "ROLE_NOT_FOUND"
  | "RUNTIME_ROLE_PRIVILEGED"
  | "RUNTIME_ROLE_INHERITS_OWNER"
  | "RUNTIME_ROLE_OWNS_OBJECTS"
  | "APPLICATION_TABLES_MISSING";

export class DatabaseGrantError extends Error {
  readonly code: DatabaseGrantErrorCode;

  constructor(code: DatabaseGrantErrorCode, message: string) {
    super(message);
    this.name = "DatabaseGrantError";
    this.code = code;
  }
}

export type DatabaseGrantRoles = Readonly<{
  readerRole: string;
  writerRole: string;
}>;

export type DatabaseGrantPlanInput = DatabaseGrantRoles & Readonly<{
  database: string;
  schema?: string;
  tables: readonly string[];
  sequences: readonly string[];
}>;

const ROLE_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export function resolveGrantRoles(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseGrantRoles {
  return validateGrantRoles({
    readerRole: env[READ_ROLE_ENV] || DEFAULT_READ_ROLE,
    writerRole: env[WRITE_ROLE_ENV] || DEFAULT_WRITE_ROLE,
  });
}

export function validateGrantRoles(roles: DatabaseGrantRoles): DatabaseGrantRoles {
  for (const role of [roles.readerRole, roles.writerRole]) {
    if (!ROLE_NAME_PATTERN.test(role)) {
      throw new DatabaseGrantError(
        "INVALID_ROLE_NAME",
        "Runtime role names must be lowercase PostgreSQL identifiers",
      );
    }
  }
  if (roles.readerRole === roles.writerRole) {
    throw new DatabaseGrantError(
      "ROLES_NOT_DISTINCT",
      "The read and write roles must be different PostgreSQL roles",
    );
  }
  return Object.freeze({ ...roles });
}

/** Builds the ordered, idempotent statements for one schema. Pure. */
export function buildDatabaseGrantPlan(input: DatabaseGrantPlanInput): readonly string[] {
  const { readerRole, writerRole } = validateGrantRoles(input);
  const schema = quoteIdentifier(input.schema ?? APPLICATION_SCHEMA);
  const reader = quoteIdentifier(readerRole);
  const writer = quoteIdentifier(writerRole);
  const runtime = `${reader}, ${writer}`;
  const statements: string[] = [
    // Nobody but the owner may create objects in the application schema.
    `REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`,
    `REVOKE ALL ON SCHEMA ${schema} FROM ${runtime}`,
    `GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`,
    `GRANT CONNECT ON DATABASE ${quoteIdentifier(input.database)} TO ${runtime}`,
  ];

  for (const table of [...input.tables].sort()) {
    const target = `${schema}.${quoteIdentifier(table)}`;
    statements.push(`REVOKE ALL ON TABLE ${target} FROM ${runtime}`);
    if (table === PRISMA_MIGRATIONS_TABLE) continue;
    statements.push(`GRANT SELECT ON TABLE ${target} TO ${runtime}`);
    const writes = WRITER_TABLE_PRIVILEGES[table] ?? [];
    if (writes.length > 0) {
      statements.push(`GRANT ${writes.join(", ")} ON TABLE ${target} TO ${writer}`);
    }
  }

  for (const sequence of [...input.sequences].sort()) {
    const target = `${schema}.${quoteIdentifier(sequence)}`;
    statements.push(`REVOKE ALL ON SEQUENCE ${target} FROM ${runtime}`);
    statements.push(`GRANT USAGE, SELECT ON SEQUENCE ${target} TO ${writer}`);
  }

  // Objects the migration owner creates later (future Prisma migrations)
  // are readable by both runtime roles and writable by nobody until this
  // reviewed matrix grants DML and the plan is re-applied.
  statements.push(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${runtime}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${runtime}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${runtime}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${writer}`,
  );

  return Object.freeze(statements);
}

export type GrantQueryable = Readonly<{
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}>;

export type DatabaseGrantResult = Readonly<{
  readerRole: string;
  writerRole: string;
  schema: string;
  tables: readonly string[];
  sequences: readonly string[];
  statementCount: number;
}>;

/**
 * Verifies preconditions and applies the plan in one transaction. Must run as
 * the migration owner so ALTER DEFAULT PRIVILEGES covers the objects future
 * migrations create.
 */
export async function applyDatabaseGrants(
  client: GrantQueryable,
  roles: DatabaseGrantRoles,
  schema: string = APPLICATION_SCHEMA,
): Promise<DatabaseGrantResult> {
  const { readerRole, writerRole } = validateGrantRoles(roles);
  const runtimeRoles = [readerRole, writerRole];

  await client.query("BEGIN");
  try {
    const roleRows = (await client.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication,
              rolbypassrls, pg_has_role(rolname, current_user, 'MEMBER') AS inherits_owner,
              rolname = current_user AS is_owner
         FROM pg_roles WHERE rolname = ANY($1::text[])`,
      [runtimeRoles],
    )).rows;
    for (const role of runtimeRoles) {
      const row = roleRows.find(({ rolname }) => rolname === role);
      if (!row) {
        throw new DatabaseGrantError("ROLE_NOT_FOUND", `Runtime role ${role} does not exist`);
      }
      if (row.rolsuper || row.rolcreaterole || row.rolcreatedb ||
        row.rolreplication || row.rolbypassrls) {
        throw new DatabaseGrantError(
          "RUNTIME_ROLE_PRIVILEGED",
          `Runtime role ${role} must not have SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, or BYPASSRLS`,
        );
      }
      if (row.is_owner || row.inherits_owner) {
        throw new DatabaseGrantError(
          "RUNTIME_ROLE_INHERITS_OWNER",
          `Runtime role ${role} must not be, or be a member of, the migration owner`,
        );
      }
    }

    const owned = (await client.query(
      `SELECT count(*)::int AS count
         FROM pg_class AS object
         JOIN pg_namespace AS namespace ON namespace.oid = object.relnamespace
         JOIN pg_roles AS owner ON owner.oid = object.relowner
        WHERE namespace.nspname = $1 AND owner.rolname = ANY($2::text[])`,
      [schema, runtimeRoles],
    )).rows[0];
    const ownedSchema = (await client.query(
      `SELECT count(*)::int AS count
         FROM pg_namespace AS namespace
         JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE owner.rolname = ANY($1::text[])`,
      [runtimeRoles],
    )).rows[0];
    if (Number(owned?.count) > 0 || Number(ownedSchema?.count) > 0) {
      throw new DatabaseGrantError(
        "RUNTIME_ROLE_OWNS_OBJECTS",
        "Runtime roles must not own schemas or application objects; transfer ownership to the migration owner first",
      );
    }

    const tables = (await client.query(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
      [schema],
    )).rows.map(({ name }) => String(name));
    const missing = Object.keys(WRITER_TABLE_PRIVILEGES)
      .filter((table) => !tables.includes(table));
    if (missing.length > 0) {
      throw new DatabaseGrantError(
        "APPLICATION_TABLES_MISSING",
        `Apply committed migrations before grants; missing tables: ${missing.join(", ")}`,
      );
    }

    const sequences = (await client.query(
      `SELECT sequencename AS name FROM pg_sequences WHERE schemaname = $1 ORDER BY sequencename`,
      [schema],
    )).rows.map(({ name }) => String(name));
    const database = String((await client.query(
      "SELECT current_database() AS name",
    )).rows[0]?.name);

    const statements = buildDatabaseGrantPlan({
      readerRole,
      writerRole,
      database,
      schema,
      tables,
      sequences,
    });
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");

    return Object.freeze({
      readerRole,
      writerRole,
      schema,
      tables: Object.freeze(tables),
      sequences: Object.freeze(sequences),
      statementCount: statements.length,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll("\"", "\"\"")}"`;
}
