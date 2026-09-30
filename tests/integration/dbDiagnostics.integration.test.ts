import assert from "node:assert/strict";
import test from "node:test";
import { db } from "@/lib/dbClient";

test("Database Diagnostics Script Logic Executes Safely", async () => {
  // We simply verify that the queries used by the diagnostic script
  // are structurally valid, parse correctly against the postgres provider,
  // and do not require superuser permissions (which would fail in CI).

  // 1. Table Stats Query
  const tableStats = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT 
      relname AS "tableName",
      n_live_tup AS "liveTuples",
      n_dead_tup AS "deadTuples",
      last_autovacuum AS "lastAutovacuum",
      last_autoanalyze AS "lastAutoanalyze",
      ROUND((n_dead_tup::numeric / GREATEST(n_live_tup + n_dead_tup, 1)) * 100, 2) AS "deadTuplePercent"
    FROM pg_stat_user_tables
    ORDER BY n_dead_tup DESC
    LIMIT 1;
  `;

  assert.ok(Array.isArray(tableStats), "Expected tableStats to be an array");

  // 2. Storage Stats Query
  const storageStats = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT
      relname AS "tableName",
      pg_size_pretty(pg_table_size(relid)) AS "tableSize",
      pg_size_pretty(pg_indexes_size(relid)) AS "indexSize",
      pg_size_pretty(pg_total_relation_size(relid)) AS "totalSize"
    FROM pg_catalog.pg_statio_user_tables
    ORDER BY pg_total_relation_size(relid) DESC
    LIMIT 1;
  `;

  assert.ok(Array.isArray(storageStats), "Expected storageStats to be an array");
});
