/**
 * Migration target safety preflight checks.
 *
 * Before applying destructive or schema-altering migration operations
 * (`prisma migrate deploy`, `prisma db push`, etc.), this preflight inspects
 * the target database to guarantee:
 * 1. Clean databases are safely recognized for initial migration.
 * 2. Already initialized, compatible databases are allowed for additive migration.
 * 3. Databases with unexpected foreign tables or incompatible column states are
 *    detected and blocked before any destructive operations can occur.
 * 4. Preflight execution is strictly read-only and never overwrites or mutates data.
 * 5. Diagnostics identify the class of incompatibility safely without leaking credentials.
 */

export const KNOWN_STELLARCORE_TABLES = Object.freeze([
  "_prisma_migrations",
  "anchors",
  "corridors",
  "anchor_corridors",
  "rate_snapshots",
  "transfer_outcomes",
  "reputation_scores",
  "database_environment",
  "scheduled_source_suppressions",
]);

export type MigrationSafetyIncompatibilityClass =
  | "UNEXPECTED_TABLES"
  | "SCHEMA_INCOMPATIBILITY"
  | "UNRECOGNIZED_STATE";

export type MigrationSafetyDiagnostic =
  | Readonly<{
      safe: true;
      state: "CLEAN" | "COMPATIBLE";
      tables: readonly string[];
    }>
  | Readonly<{
      safe: false;
      incompatibilityClass: MigrationSafetyIncompatibilityClass;
      message: string;
      unexpectedTables?: readonly string[];
      incompatibleColumns?: readonly string[];
    }>;

export interface MigrationIntrospectionClient {
  listTables(): Promise<readonly string[]>;
  listColumns?(table: string): Promise<readonly { name: string; type: string }[]>;
}

/**
 * Evaluates whether a target database state is safe for migration.
 * Strictly read-only: does not execute any DDL or DML mutations.
 */
export async function checkMigrationTargetSafety(
  client: MigrationIntrospectionClient,
  options: Readonly<{
    knownTables?: readonly string[];
    requiredColumns?: Readonly<Record<string, readonly string[]>>;
  }> = {},
): Promise<MigrationSafetyDiagnostic> {
  const known = new Set(options.knownTables ?? KNOWN_STELLARCORE_TABLES);
  const tables = await client.listTables();

  // 1. Clean database state: empty or only empty _prisma_migrations
  if (tables.length === 0 || (tables.length === 1 && tables[0] === "_prisma_migrations")) {
    return Object.freeze({
      safe: true,
      state: "CLEAN",
      tables: Object.freeze([...tables]),
    });
  }

  // 2. Detect unexpected foreign tables
  const unexpected = tables.filter((t) => !known.has(t));
  if (unexpected.length > 0) {
    return Object.freeze({
      safe: false,
      incompatibilityClass: "UNEXPECTED_TABLES",
      message: `Target database contains unexpected existing table(s): ${unexpected.sort().join(", ")}. Refusing migration to prevent silent data corruption or overwrite.`,
      unexpectedTables: Object.freeze(unexpected.sort()),
    });
  }

  // 3. Inspect column invariants on known tables if column introspection is provided
  if (client.listColumns && options.requiredColumns) {
    const incompatibleColumns: string[] = [];
    for (const [table, requiredCols] of Object.entries(options.requiredColumns)) {
      if (tables.includes(table)) {
        const existingColumns = await client.listColumns(table);
        const colNames = new Set(existingColumns.map((c) => c.name));
        for (const reqCol of requiredCols) {
          if (!colNames.has(reqCol)) {
            incompatibleColumns.push(`${table}.${reqCol}`);
          }
        }
      }
    }

    if (incompatibleColumns.length > 0) {
      return Object.freeze({
        safe: false,
        incompatibilityClass: "SCHEMA_INCOMPATIBILITY",
        message: `Target database schema is incompatible; missing required column(s): ${incompatibleColumns.sort().join(", ")}.`,
        incompatibleColumns: Object.freeze(incompatibleColumns.sort()),
      });
    }
  }

  // 4. Compatible known state
  return Object.freeze({
    safe: true,
    state: "COMPATIBLE",
    tables: Object.freeze([...tables]),
  });
}
