import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_DATABASE_MAX_CONNECTIONS,
  TOTAL_MAX_CONNECTIONS,
  TOTAL_RESERVED_CONNECTIONS,
  WORKLOAD_BUDGETS,
  createWorkloadPoolConfig,
  getWorkloadConnectionString,
  validateWorkloadBudgets,
  type WorkloadBudgetConfig,
  type WorkloadClass,
} from "@/lib/config/workloadBudgets";

test("aggregate configured capacity stays within the documented database limit", () => {
  assert.ok(TOTAL_MAX_CONNECTIONS <= DEFAULT_DATABASE_MAX_CONNECTIONS);
  assert.equal(TOTAL_MAX_CONNECTIONS, 90);
  assert.equal(TOTAL_RESERVED_CONNECTIONS, 8);
  assert.doesNotThrow(() => validateWorkloadBudgets(WORKLOAD_BUDGETS));
});

test("each workload class has an explicit, non-overlapping reservation", () => {
  const total = Object.values(WORKLOAD_BUDGETS).reduce(
    (sum, budget) => sum + budget.maxConnections,
    0,
  );
  assert.equal(total, TOTAL_MAX_CONNECTIONS);
  for (const budget of Object.values(WORKLOAD_BUDGETS)) {
    assert.ok(budget.minConnections >= 0);
    assert.ok(budget.minConnections <= budget.maxConnections);
    assert.ok(budget.maxConnections > 0);
  }
});

test("validateWorkloadBudgets rejects aggregate capacity above the provider limit", () => {
  const oversized = {
    ...WORKLOAD_BUDGETS,
    public: { ...WORKLOAD_BUDGETS.public, maxConnections: 80 },
  } as Record<WorkloadClass, WorkloadBudgetConfig>;
  assert.throws(
    () => validateWorkloadBudgets(oversized),
    /exceeds database max connections/,
  );
});

test("validateWorkloadBudgets rejects reserved capacity above the provider limit", () => {
  const oversized = {
    ...WORKLOAD_BUDGETS,
    scheduled: { ...WORKLOAD_BUDGETS.scheduled, minConnections: 120 },
  } as Record<WorkloadClass, WorkloadBudgetConfig>;
  assert.throws(
    () => validateWorkloadBudgets(oversized),
    /minConnections.*exceeds/,
  );
});

test("overload behavior differs per class: public reads fail fast, scheduled waits longer", () => {
  assert.ok(
    WORKLOAD_BUDGETS.public.acquisitionTimeoutMs <
      WORKLOAD_BUDGETS.scheduled.acquisitionTimeoutMs,
  );
  assert.ok(
    WORKLOAD_BUDGETS.public.statementTimeoutMs <
      WORKLOAD_BUDGETS.scheduled.statementTimeoutMs,
  );
  assert.equal(WORKLOAD_BUDGETS.maintenance.canBorrow, false);
});

test("pool config maps budgets to bounded connection behavior", () => {
  const config = createWorkloadPoolConfig("public");
  assert.equal(config.max, WORKLOAD_BUDGETS.public.maxConnections);
  assert.equal(config.min, WORKLOAD_BUDGETS.public.minConnections);
  assert.equal(config.connectionTimeoutMillis, WORKLOAD_BUDGETS.public.acquisitionTimeoutMs);
  assert.equal(config.statement_timeout, WORKLOAD_BUDGETS.public.statementTimeoutMs);
  assert.equal(config.application_name, "stellarcore-public");

  const scheduled = createWorkloadPoolConfig("scheduled");
  assert.equal(scheduled.application_name, "stellarcore-scheduled");
  assert.ok(scheduled.connectionTimeoutMillis > config.connectionTimeoutMillis);
});

test("getWorkloadConnectionString requires DATABASE_URL", () => {
  const original = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    assert.throws(() => getWorkloadConnectionString(), /DATABASE_URL is not defined/);
    process.env.DATABASE_URL = "postgresql://localhost/db";
    assert.equal(getWorkloadConnectionString(), "postgresql://localhost/db");
  } finally {
    if (original === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = original;
    }
  }
});
