import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "pg";

import { createBoundedDatabaseClient, describeDatabasePool } from "@/lib/db/connection";
import { classifyDatabaseFailure } from "@/lib/db/errors";

import {
  arrayRows,
  createProbeTable,
  databaseBudgetIntegrationEnabled,
  dropProbeTable,
  integrationConnectionString,
  testBudget,
} from "./postgresHarness";

const ENABLED = databaseBudgetIntegrationEnabled();

async function statementTimeoutMs(client: {
  $queryRawUnsafe: (query: string) => Promise<unknown>;
}): Promise<string | undefined> {
  const rows = arrayRows<{ setting: string }>(
    await client.$queryRawUnsafe("SELECT setting FROM pg_settings WHERE name = 'statement_timeout'"),
  );
  return rows[0]?.setting;
}

test(
  "a full small pool rejects excess acquisition within its configured bound without exceeding its cap",
  { skip: !ENABLED },
  async () => {
    await import("dotenv/config");
    const connectionString = integrationConnectionString();
    const budget = testBudget("read", {
      poolMax: 1,
      connectionTimeoutMs: 400,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 10_000,
      interactiveTransactionTimeoutMs: 10_000,
      interactiveTransactionMaxWaitMs: 10_000,
    });
    const { client, pool } = createBoundedDatabaseClient({
      role: "read:test:saturation",
      connectionString,
      budget,
    });

    const held = await pool.connect();
    try {
      const startedAt = Date.now();
      let captured: unknown;
      try {
        await client.$queryRawUnsafe("SELECT 1");
      } catch (error) {
        captured = error;
      }
      const elapsed = Date.now() - startedAt;

      assert.notEqual(captured, undefined, "expected excess acquisition to be rejected");
      assert.equal(classifyDatabaseFailure(captured).code, "database_pool_timeout");
      assert.ok(elapsed >= 150, `acquisition returned too fast to be bounded: ${elapsed}ms`);
      assert.ok(elapsed < 2_000, `acquisition exceeded its bound: ${elapsed}ms`);

      const snapshot = describeDatabasePool(pool);
      assert.equal(snapshot.max, 1);
      assert.ok(snapshot.total <= 1, `pool opened ${snapshot.total} connections above its cap`);
    } finally {
      held.release();
      await client.$disconnect();
    }
  },
);

test(
  "an isolated slow query is cancelled by the server-side statement budget and the pool recovers",
  { skip: !ENABLED },
  async () => {
    await import("dotenv/config");
    const connectionString = integrationConnectionString();
    const budget = testBudget("read", {
      poolMax: 2,
      connectionTimeoutMs: 2_000,
      statementTimeoutMs: 300,
      lockTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 10_000,
    });
    const { client } = createBoundedDatabaseClient({
      role: "read:test:statement",
      connectionString,
      budget,
    });

    try {
      assert.equal(await statementTimeoutMs(client), "300");

      const startedAt = Date.now();
      let captured: unknown;
      try {
        await client.$queryRawUnsafe("SELECT pg_sleep(5)");
      } catch (error) {
        captured = error;
      }
      const elapsed = Date.now() - startedAt;

      assert.notEqual(captured, undefined, "expected the slow query to be cancelled");
      assert.equal(classifyDatabaseFailure(captured).code, "database_statement_timeout");
      assert.ok(elapsed < 3_000, `slow query ran for ${elapsed}ms`);

      const recovered = arrayRows<{ ok: number }>(
        await client.$queryRawUnsafe("SELECT 1 AS ok"),
      );
      assert.equal(Number(recovered[0]?.ok), 1);
      assert.equal(await statementTimeoutMs(client), "300");
    } finally {
      await client.$disconnect();
    }
  },
);

test(
  "a lock-blocked write is cancelled, rolled back, and leaves no late side effect",
  { skip: !ENABLED },
  async () => {
    await import("dotenv/config");
    const connectionString = integrationConnectionString();
    const table = await createProbeTable(connectionString);
    const blocker = new Client({ connectionString });
    await blocker.connect();

    const budget = testBudget("write", {
      poolMax: 2,
      connectionTimeoutMs: 3_000,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 300,
      idleInTransactionTimeoutMs: 5_000,
      interactiveTransactionTimeoutMs: 5_000,
      interactiveTransactionMaxWaitMs: 3_000,
    });
    const { client, pool } = createBoundedDatabaseClient({
      role: "write:test:lock",
      connectionString,
      budget,
    });

    try {
      await blocker.query("BEGIN");
      await blocker.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);

      const startedAt = Date.now();
      let captured: unknown;
      try {
        await client.$transaction(
          async (transaction) => {
            await transaction.$executeRawUnsafe(
              `UPDATE ${table} SET value = value + 1 WHERE id = 1`,
            );
          },
          { timeout: 5_000, maxWait: 3_000 },
        );
      } catch (error) {
        captured = error;
      }
      const elapsed = Date.now() - startedAt;

      assert.notEqual(captured, undefined, "expected the blocked write to be cancelled");
      assert.equal(classifyDatabaseFailure(captured).code, "database_lock_timeout");
      assert.ok(elapsed < 3_000, `blocked write ran for ${elapsed}ms`);

      await blocker.query("ROLLBACK");

      const rolledBack = arrayRows<{ value: number }>(
        await client.$queryRawUnsafe(`SELECT value FROM ${table} WHERE id = 1`),
      );
      assert.equal(Number(rolledBack[0]?.value), 0, "blocked write left a late side effect");

      await client.$executeRawUnsafe(`UPDATE ${table} SET value = 1 WHERE id = 1`);
      const after = arrayRows<{ value: number }>(
        await client.$queryRawUnsafe(`SELECT value FROM ${table} WHERE id = 1`),
      );
      assert.equal(Number(after[0]?.value), 1);

      const snapshot = describeDatabasePool(pool);
      assert.ok(snapshot.total <= budget.poolMax, `pool leaked a client: ${snapshot.total}`);
      assert.ok(snapshot.idle >= 1, "pool did not return the recovered connection");
    } finally {
      await blocker.end().catch(() => undefined);
      await client.$disconnect();
      await dropProbeTable(connectionString, table);
    }
  },
);

test(
  "session policy is isolated per pool and unchanged after a failure",
  { skip: !ENABLED },
  async () => {
    await import("dotenv/config");
    const connectionString = integrationConnectionString();
    const read = createBoundedDatabaseClient({
      role: "read:test:isolation",
      connectionString,
      budget: testBudget("read", {
        poolMax: 1,
        connectionTimeoutMs: 2_000,
        statementTimeoutMs: 250,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 10_000,
      }),
    });
    const write = createBoundedDatabaseClient({
      role: "write:test:isolation",
      connectionString,
      budget: testBudget("write", {
        poolMax: 1,
        connectionTimeoutMs: 2_000,
        statementTimeoutMs: 1_200,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 10_000,
        interactiveTransactionTimeoutMs: 5_000,
        interactiveTransactionMaxWaitMs: 3_000,
      }),
    });

    try {
      assert.equal(await statementTimeoutMs(read.client), "250");
      assert.equal(await statementTimeoutMs(write.client), "1200");

      const readName = arrayRows<{ application_name: string }>(
        await read.client.$queryRawUnsafe(
          "SELECT current_setting('application_name') AS application_name",
        ),
      );
      assert.equal(readName[0]?.application_name, "stellarcore:test:read");

      await assert.rejects(() => read.client.$queryRawUnsafe("SELECT pg_sleep(5)"));

      assert.equal(await statementTimeoutMs(read.client), "250");
      const writeAlive = arrayRows<{ ok: number }>(
        await write.client.$queryRawUnsafe("SELECT 1 AS ok"),
      );
      assert.equal(Number(writeAlive[0]?.ok), 1);
    } finally {
      await read.client.$disconnect();
      await write.client.$disconnect();
    }
  },
);

test(
  "establishing a connection to an unreachable host is bounded",
  { skip: !ENABLED },
  async () => {
    const budget = testBudget("read", {
      poolMax: 1,
      connectionTimeoutMs: 500,
      statementTimeoutMs: 1_000,
      lockTimeoutMs: 1_000,
      idleInTransactionTimeoutMs: 5_000,
    });
    const { client } = createBoundedDatabaseClient({
      role: "read:test:unreachable",
      // TEST-NET-1 is guaranteed non-routable, so establishment must be bounded.
      connectionString: "postgresql://postgres:postgres@192.0.2.1:5432/stellarcore_budget",
      budget,
    });

    try {
      const startedAt = Date.now();
      let captured: unknown;
      try {
        await client.$queryRawUnsafe("SELECT 1");
      } catch (error) {
        captured = error;
      }
      const elapsed = Date.now() - startedAt;

      assert.notEqual(captured, undefined, "expected connection establishment to fail");
      const code = classifyDatabaseFailure(captured).code;
      assert.ok(
        code === "database_connection_timeout" || code === "database_connection_failure",
        `unexpected classification: ${code}`,
      );
      assert.ok(elapsed < 3_000, `connection establishment ran for ${elapsed}ms`);
    } finally {
      await client.$disconnect();
    }
  },
);

test(
  "read saturation does not consume writer capacity",
  { skip: !ENABLED },
  async () => {
    await import("dotenv/config");
    const connectionString = integrationConnectionString();
    const read = createBoundedDatabaseClient({
      role: "read:test:credential-isolation",
      connectionString,
      budget: testBudget("read", {
        poolMax: 1,
        connectionTimeoutMs: 400,
        statementTimeoutMs: 5_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 10_000,
      }),
    });
    const write = createBoundedDatabaseClient({
      role: "write:test:credential-isolation",
      connectionString,
      budget: testBudget("write", {
        poolMax: 1,
        connectionTimeoutMs: 3_000,
        statementTimeoutMs: 5_000,
        lockTimeoutMs: 5_000,
        idleInTransactionTimeoutMs: 10_000,
        interactiveTransactionTimeoutMs: 5_000,
        interactiveTransactionMaxWaitMs: 3_000,
      }),
    });

    const held = await read.pool.connect();
    try {
      await assert.rejects(() => read.client.$queryRawUnsafe("SELECT 1"));

      const writeAlive = arrayRows<{ ok: number }>(
        await write.client.$queryRawUnsafe("SELECT 1 AS ok"),
      );
      assert.equal(Number(writeAlive[0]?.ok), 1);
      assert.equal(describeDatabasePool(write.pool).total, 1);
    } finally {
      held.release();
      await read.client.$disconnect();
      await write.client.$disconnect();
    }
  },
);
