import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";

import {
  createHardenedPool,
  evictStalePoolConnections,
  handleConnectionError,
  handlePoolError,
  resolveHardenedPoolOptions,
} from "@/lib/db/poolManager";

test("resolveHardenedPoolOptions provides robust production defaults", () => {
  const options = resolveHardenedPoolOptions();

  assert.equal(options.connectionTimeoutMillis, 5000);
  assert.equal(options.idleTimeoutMillis, 30000);
  assert.equal(options.maxLifetimeSeconds, 1800);
  assert.equal(options.keepAlive, true);
  assert.equal(options.keepAliveInitialDelayMillis, 10000);
  assert.equal(options.max, 10);
});

test("resolveHardenedPoolOptions accepts explicit overrides and env variables", () => {
  const previousEnv = { ...process.env };
  try {
    process.env.DB_CONNECTION_TIMEOUT_MS = "2500";
    process.env.DB_POOL_MAX = "20";
    process.env.DB_IDLE_TIMEOUT_MS = "invalid";

    const options = resolveHardenedPoolOptions({ maxLifetimeSeconds: 600 });

    assert.equal(options.connectionTimeoutMillis, 2500);
    assert.equal(options.max, 20);
    assert.equal(options.maxLifetimeSeconds, 600);
    assert.equal(options.idleTimeoutMillis, 30000); // Fell back to default due to invalid env
  } finally {
    process.env = previousEnv;
  }
});

test("createHardenedPool instantiates Pool with options and attaches error listener", () => {
  const pool = createHardenedPool("postgresql://localhost:5432/testdb", {
    max: 5,
    connectionTimeoutMillis: 1000,
  });

  try {
    assert.ok(pool instanceof Pool);
    assert.equal(pool.options.max, 5);
    assert.equal(pool.options.connectionTimeoutMillis, 1000);
    assert.equal(pool.options.keepAlive, true);
    assert.ok(pool.listenerCount("error") > 0);
  } finally {
    void pool.end();
  }
});

test("evictStalePoolConnections removes idle connections from pool", () => {
  const pool = new Pool();
  try {
    const internalPool = pool as unknown as {
      _idle: Array<{ client: unknown }>;
      _clients: unknown[];
      _remove: (client: unknown) => void;
    };

    let removedCount = 0;
    const fakeClient1 = { id: 1 };
    const fakeClient2 = { id: 2 };

    internalPool._clients.push(fakeClient1, fakeClient2);
    internalPool._idle.push({ client: fakeClient1 }, { client: fakeClient2 });

    const originalRemove = internalPool._remove.bind(internalPool);
    internalPool._remove = (client: unknown) => {
      removedCount += 1;
      originalRemove(client);
    };

    assert.equal(pool.idleCount, 2);
    const evicted = evictStalePoolConnections(pool);
    assert.equal(evicted, 2);
    assert.equal(removedCount, 2);
    assert.equal(pool.idleCount, 0);
  } finally {
    void pool.end();
  }
});

test("handlePoolError and handleConnectionError evict idle connections on failover errors only", () => {
  const pool = new Pool();
  try {
    const internalPool = pool as unknown as {
      _idle: Array<{ client: unknown }>;
      _remove: (client: unknown) => void;
    };

    let removed = 0;
    internalPool._remove = () => {
      removed += 1;
      internalPool._idle.length = 0;
    };

    // Non-failover error should not evict
    internalPool._idle.push({ client: {} });
    handlePoolError(pool, Object.assign(new Error("Constraint violation"), { code: "23505" }));
    assert.equal(removed, 0);

    // Failover error should evict
    handlePoolError(pool, Object.assign(new Error("Connection reset"), { code: "ECONNRESET" }));
    assert.equal(removed, 1);

    // Connection error with admin shutdown should evict
    internalPool._idle.push({ client: {} });
    handleConnectionError(pool, Object.assign(new Error("Shutdown"), { code: "57P01" }));
    assert.equal(removed, 2);
  } finally {
    void pool.end();
  }
});
