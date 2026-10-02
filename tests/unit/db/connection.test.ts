import assert from "node:assert/strict";
import test from "node:test";

import { databaseBudgetDefaults, type DatabaseBudget } from "@/lib/db/budget";
import {
  buildPoolConfig,
  createBoundedDatabaseClient,
  describeDatabasePool,
} from "@/lib/db/connection";

function budget(overrides: Partial<DatabaseBudget> = {}): DatabaseBudget {
  return Object.freeze({
    profile: "read",
    applicationName: "stellarcore:read",
    ...databaseBudgetDefaults("read"),
    ...overrides,
  });
}

test("pool config maps every budget bound to the installed pg option", () => {
  const config = buildPoolConfig("postgresql://user:secret@db.internal:5432/app", budget({
    poolMax: 3,
    connectionTimeoutMs: 1_234,
    idleTimeoutMs: 45_000,
    maxLifetimeSeconds: 900,
    statementTimeoutMs: 4_000,
    lockTimeoutMs: 500,
    idleInTransactionTimeoutMs: 6_000,
  }));

  assert.equal(config.max, 3);
  assert.equal(config.connectionTimeoutMillis, 1_234);
  assert.equal(config.idleTimeoutMillis, 45_000);
  assert.equal(config.maxLifetimeSeconds, 900);
  assert.equal(config.statement_timeout, 4_000);
  assert.equal(config.lock_timeout, 500);
  assert.equal(config.idle_in_transaction_session_timeout, 6_000);
  assert.equal(config.application_name, "stellarcore:read");
  // Client-side abandonment is deliberately not part of the policy.
  assert.equal(config.query_timeout, undefined);
});

test("created client exposes bounded pool options and can be built without connecting", async () => {
  const created = createBoundedDatabaseClient({
    role: "read:unit",
    connectionString: "postgresql://user:secret@127.0.0.1:1/app",
    budget: budget({ poolMax: 2, connectionTimeoutMs: 100, statementTimeoutMs: 250 }),
  });

  try {
    assert.equal(created.pool.options.max, 2);
    assert.equal(created.pool.options.connectionTimeoutMillis, 100);
    assert.equal(created.pool.options.statement_timeout, 250);
    assert.equal(created.budget.profile, "read");
    assert.equal(describeDatabasePool(created.pool).total, 0);
  } finally {
    await created.client.$disconnect();
  }
});
