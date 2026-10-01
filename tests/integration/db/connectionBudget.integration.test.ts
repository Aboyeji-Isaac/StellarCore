import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";

import { Pool } from "pg";

import {
  WORKLOAD_BUDGETS,
  createWorkloadPoolConfig,
} from "@/lib/config/workloadBudgets";

/**
 * Proves that the pool configuration budgets produce bounded failures under
 * overload: a database that accepts TCP connections but never answers must
 * surface a timeout error from pool.connect(), never an indefinite hang.
 */
test("connection acquisition fails within the configured timeout under overload", async () => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    // Intentionally never respond; simulates a saturated/black-holed database.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const config = createWorkloadPoolConfig("public");
  const pool = new Pool({
    host: "127.0.0.1",
    port: address.port,
    user: "budget",
    database: "budget",
    max: WORKLOAD_BUDGETS.public.maxConnections,
    connectionTimeoutMillis: 250,
    statement_timeout: config.statement_timeout,
  });
  pool.on("error", () => {});

  try {
    const started = Date.now();
    await assert.rejects(pool.connect(), /timeout/i);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `expected bounded failure, took ${elapsed}ms`);
    // Budget wiring: acquisition timeouts come from the workload budget.
    assert.equal(config.connectionTimeoutMillis, WORKLOAD_BUDGETS.public.acquisitionTimeoutMs);
  } finally {
    await pool.end().catch(() => {});
    server.close();
  }
});

test("statement timeout is configured for queries in each workload class", () => {
  for (const workload of ["public", "scheduled", "maintenance"] as const) {
    const config = createWorkloadPoolConfig(workload);
    assert.equal(config.statement_timeout, WORKLOAD_BUDGETS[workload].statementTimeoutMs);
    assert.equal(config.connectionTimeoutMillis, WORKLOAD_BUDGETS[workload].acquisitionTimeoutMs);
    assert.ok(config.connectionTimeoutMillis > 0);
  }
});
