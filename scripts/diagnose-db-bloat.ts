import { db } from "@/lib/dbClient";

async function main() {
  console.log("StellarCore Database Bloat & Maintenance Diagnostics");
  console.log("==================================================\n");

  try {
    // 1. Table Statistics (Dead Tuples, Last Vacuum/Analyze)
    console.log("--- Table Statistics ---");
    const tableStats = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT 
        relname AS "tableName",
        n_live_tup AS "liveTuples",
        n_dead_tup AS "deadTuples",
        last_autovacuum AS "lastAutovacuum",
        last_autoanalyze AS "lastAutoanalyze",
        ROUND((n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup, 1)) * 100, 2) AS "deadTuplePercent"
      FROM pg_stat_user_tables
      ORDER BY n_dead_tup DESC;
    `;

    console.table(
      tableStats.map((t) => ({
        Table: t.tableName,
        "Live Tuples": Number(t.liveTuples),
        "Dead Tuples": Number(t.deadTuples),
        "Dead %": `${t.deadTuplePercent}%`,
        "Last Autovacuum": t.lastAutovacuum ? new Date(t.lastAutovacuum).toISOString() : "Never",
        "Last Autoanalyze": t.lastAutoanalyze ? new Date(t.lastAutoanalyze).toISOString() : "Never",
      }))
    );

    console.log("\n--- Storage Sizes ---");
    // 2. Table & Index Storage Sizes (Provider Compatible & Read Only)
    const storageStats = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT
        relname AS "tableName",
        pg_size_pretty(pg_table_size(relid)) AS "tableSize",
        pg_size_pretty(pg_indexes_size(relid)) AS "indexSize",
        pg_size_pretty(pg_total_relation_size(relid)) AS "totalSize",
        pg_indexes_size(relid) AS "rawIndexSize",
        pg_table_size(relid) AS "rawTableSize"
      FROM pg_catalog.pg_statio_user_tables
      ORDER BY pg_total_relation_size(relid) DESC;
    `;

    console.table(
      storageStats.map((s) => ({
        Table: s.tableName,
        "Table Size": s.tableSize,
        "Index Size": s.indexSize,
        "Total Size": s.totalSize,
        "Index/Table Ratio":
          Number(s.rawTableSize) > 0
            ? (Number(s.rawIndexSize) / Number(s.rawTableSize)).toFixed(2)
            : "N/A",
      }))
    );

    console.log("\nDiagnostics completed successfully.");
    console.log("Consult docs/database-maintenance.md for threshold evaluation and remediation.");
  } catch (error) {
    console.error("Failed to run diagnostics:", error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
