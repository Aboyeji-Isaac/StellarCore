import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import type { Pool, PoolClient } from "pg";
import { isFailoverOrConnectionError } from "@/lib/db/failoverErrors";
import { createHardenedPool, handleConnectionError } from "@/lib/db/poolManager";
import {
  executeSafeTransaction,
  TransactionInterruptedError,
} from "@/lib/db/transactionSafety";
import {
  createMockPostgresServer,
  type MockPostgresServer,
} from "@/tests/integration/db/fixtures/mockPostgresServer";

/**
 * Regression tests for reconnects after a stale pooled connection (issue #453).
 *
 * Unlike postgresFailover.integration.test.ts, the server stays up in every
 * scenario: only connections that were already pooled go bad, which is what a
 * NAT/proxy idle timeout, pg_terminate_backend, or idle_session_timeout does.
 * The mock server is an in-process wire-protocol double; no real database is
 * involved.
 */

async function withPool(
  max: number,
  run: (pool: Pool, server: MockPostgresServer) => Promise<void>,
): Promise<void> {
  const server = await createMockPostgresServer();
  const pool = createHardenedPool(server.connectionString, {
    max,
    connectionTimeoutMillis: 1000,
  });

  try {
    await run(pool, server);
  } finally {
    await pool.end();
    await server.close();
  }
}

/** Fills the pool with `count` idle connections. */
async function warmIdleConnections(pool: Pool, count: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: count }, () => pool.connect()));
  for (const client of clients) client.release();
  assert.equal(pool.idleCount, count);
}

async function rejectsWithConnectionError(work: Promise<unknown>): Promise<unknown> {
  let captured: unknown;
  await assert.rejects(work, (error: unknown) => {
    assert.ok(isFailoverOrConnectionError(error), `unclassified error: ${String(error)}`);
    captured = error;
    return true;
  });
  return captured;
}

function countQueries(server: MockPostgresServer, text: string): number {
  return server.getQueryLog().filter((query) => query === text).length;
}

test("a pooled connection that fails on use is discarded and the next query gets a healthy one", async () => {
  await withPool(2, async (pool, server) => {
    await pool.query("SELECT 1");
    assert.equal(pool.idleCount, 1);
    assert.equal(server.getTotalConnectionsCount(), 1);

    server.markExistingConnectionsStale();

    await rejectsWithConnectionError(pool.query("SELECT 1"));
    // The failed client is destroyed, not returned to the idle list.
    assert.equal(pool.totalCount, 0);
    assert.equal(pool.idleCount, 0);

    const recovered = await pool.query("SELECT 1");
    assert.equal(recovered.command, "SELECT");
    assert.equal(server.getTotalConnectionsCount(), 2);
    assert.equal(pool.totalCount, 1);
  });
});

test("without eviction a second stale idle connection fails the next request too", async () => {
  // Control case documenting the failure mode the eviction hook prevents.
  await withPool(2, async (pool, server) => {
    await warmIdleConnections(pool, 2);
    server.markExistingConnectionsStale();

    await rejectsWithConnectionError(pool.query("SELECT 1"));
    await rejectsWithConnectionError(pool.query("SELECT 1"));
  });
});

test("handleConnectionError evicts the remaining stale idle connections so only one request fails", async () => {
  await withPool(3, async (pool, server) => {
    await warmIdleConnections(pool, 3);
    server.markExistingConnectionsStale();

    const error = await rejectsWithConnectionError(pool.query("SELECT 1"));
    // dbClient wires this as PrismaPg's onConnectionError.
    handleConnectionError(pool, error);
    assert.equal(pool.idleCount, 0);
    assert.equal(pool.totalCount, 0);

    const results = await Promise.all(Array.from({ length: 5 }, () => pool.query("SELECT 1")));
    for (const result of results) assert.equal(result.command, "SELECT");

    // Recovery reconnects within the pool bound instead of storming.
    const reconnects = server.getTotalConnectionsCount() - 3;
    assert.ok(reconnects >= 1 && reconnects <= 3, `reconnects=${reconnects}`);
    assert.ok(pool.totalCount <= 3);
  });
});

test("handleConnectionError keeps healthy idle connections for ordinary query errors", async () => {
  await withPool(2, async (pool) => {
    await warmIdleConnections(pool, 2);

    handleConnectionError(pool, Object.assign(new Error("duplicate key"), { code: "23505" }));

    assert.equal(pool.idleCount, 2);
  });
});

test("an idle connection terminated by the server is removed without crashing and replaced on next use", async () => {
  await withPool(2, async (pool, server) => {
    await pool.query("SELECT 1");
    assert.equal(pool.idleCount, 1);

    const poolError = once(pool, "error");
    server.terminateExistingConnections("57P01");
    const [error] = await poolError;

    assert.ok(isFailoverOrConnectionError(error));
    assert.equal(pool.totalCount, 0);

    const recovered = await pool.query("SELECT 1");
    assert.equal(recovered.command, "SELECT");
    assert.equal(server.getTotalConnectionsCount(), 2);
  });
});

test("a mutation sent on a stale connection is attempted once and never replayed", async () => {
  await withPool(2, async (pool, server) => {
    await pool.query("SELECT 1");
    server.markExistingConnectionsStale();

    const insert = "INSERT INTO EVIDENCE VALUES (1)";
    const error = await rejectsWithConnectionError(pool.query(insert));
    handleConnectionError(pool, error);

    await pool.query("SELECT 1");
    await pool.query("SELECT 1");

    // Neither pg nor the pool manager retries the failed statement on the
    // fresh connection; replaying it is the caller's explicit decision.
    assert.equal(countQueries(server, insert), 1);
  });
});

test("a transaction that acquires a stale connection is interrupted, not replayed, and the next one commits", async () => {
  await withPool(2, async (pool, server) => {
    await pool.query("SELECT 1");
    server.markExistingConnectionsStale();

    const insert = "INSERT INTO EVIDENCE VALUES (2)";
    const runTransaction = () => executeSafeTransaction(
      async (fn: (client: PoolClient) => Promise<string>) => {
        const client = await pool.connect();
        const ignoreClientError = () => {};
        client.on("error", ignoreClientError);
        let failure: Error | undefined;
        try {
          await client.query("BEGIN");
          const result = await fn(client);
          await client.query("COMMIT");
          return result;
        } catch (error) {
          failure = error as Error;
          throw error;
        } finally {
          client.removeListener("error", ignoreClientError);
          client.release(failure);
        }
      },
      async (client) => {
        await client.query(insert);
        return "written";
      },
    );

    await assert.rejects(runTransaction(), (error: unknown) => {
      assert.ok(error instanceof TransactionInterruptedError);
      assert.equal(error.phase, "IN_FLIGHT");
      return true;
    });
    assert.equal(countQueries(server, "BEGIN"), 1);
    assert.equal(countQueries(server, insert), 0);
    assert.equal(pool.totalCount, 0);

    assert.equal(await runTransaction(), "written");
    assert.equal(countQueries(server, "BEGIN"), 2);
    assert.equal(countQueries(server, insert), 1);
    assert.equal(countQueries(server, "COMMIT"), 1);
  });
});
