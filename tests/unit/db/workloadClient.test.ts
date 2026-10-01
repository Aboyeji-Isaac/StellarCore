import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { WORKLOAD_BUDGETS, type WorkloadClass } from "@/lib/config/workloadBudgets";
import {
  getAllWorkloadPoolStats,
  getWorkloadPool,
  getWorkloadPoolStats,
  getWorkloadSaturation,
  isWorkloadSaturated,
  setWorkloadPoolFactoryForTesting,
  shutdownWorkloadClients,
} from "@/lib/db/workloadClient";

class FakePool {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  ended = false;
  on(): this {
    return this;
  }
  async end(): Promise<void> {
    this.ended = true;
    this.totalCount = 0;
    this.idleCount = 0;
    this.waitingCount = 0;
  }
}

const WORKLOADS: WorkloadClass[] = ["public", "scheduled", "maintenance"];

function setup(): Record<WorkloadClass, FakePool> {
  process.env.DATABASE_URL = "postgresql://localhost:5432/stellarcore_test";
  const pools = {
    public: new FakePool(),
    scheduled: new FakePool(),
    maintenance: new FakePool(),
  } as Record<WorkloadClass, FakePool>;
  setWorkloadPoolFactoryForTesting((workload) => pools[workload] as unknown as Pool);
  return pools;
}

async function teardown(): Promise<void> {
  await shutdownWorkloadClients();
  setWorkloadPoolFactoryForTesting(null);
}

test("each workload class gets an independent pool", async () => {
  const pools = setup();
  try {
    for (const workload of WORKLOADS) {
      assert.equal(getWorkloadPool(workload), pools[workload]);
    }
    assert.notEqual(pools.public, pools.scheduled);
    assert.notEqual(pools.scheduled, pools.maintenance);
  } finally {
    await teardown();
  }
});

test("pool budgets are reserved per class and sum within provider limit", async () => {
  setup();
  try {
    const stats = getAllWorkloadPoolStats();
    let totalMax = 0;
    for (const workload of WORKLOADS) {
      assert.equal(stats[workload].maxConnections, WORKLOAD_BUDGETS[workload].maxConnections);
      assert.equal(stats[workload].minConnections, WORKLOAD_BUDGETS[workload].minConnections);
      totalMax += stats[workload].maxConnections;
    }
    assert.ok(totalMax <= 100);
  } finally {
    await teardown();
  }
});

test("saturating the public pool does not consume scheduled capacity", async () => {
  const pools = setup();
  try {
    pools.public.totalCount = WORKLOAD_BUDGETS.public.maxConnections;
    pools.public.idleCount = 0;
    pools.public.waitingCount = 3;
    pools.scheduled.totalCount = 0;
    pools.scheduled.waitingCount = 0;

    assert.equal(isWorkloadSaturated("public"), true);
    assert.equal(getWorkloadSaturation("public"), 1);
    assert.equal(isWorkloadSaturated("scheduled"), false);
    assert.equal(getWorkloadSaturation("scheduled"), 0);

    const aggregate = getAllWorkloadPoolStats();
    const activeTotal = WORKLOADS.reduce(
      (sum, workload) => sum + aggregate[workload].totalCount,
      0,
    );
    assert.ok(activeTotal <= 90);
  } finally {
    await teardown();
  }
});

test("a heavy scheduled run cannot exhaust public capacity", async () => {
  const pools = setup();
  try {
    pools.scheduled.totalCount = WORKLOAD_BUDGETS.scheduled.maxConnections;
    pools.scheduled.idleCount = 0;
    pools.scheduled.waitingCount = 5;

    assert.equal(isWorkloadSaturated("scheduled"), true);
    assert.equal(getWorkloadSaturation("scheduled"), 1);
    assert.equal(
      getAllWorkloadPoolStats().public.totalCount,
      0,
      "public pool untouched by scheduled saturation",
    );
  } finally {
    await teardown();
  }
});

test("recovery after saturation drains pools without leaking or stranding connections", async () => {
  const pools = setup();
  try {
    for (const workload of WORKLOADS) {
      getWorkloadSaturation(workload); // force lazy pool initialization
      pools[workload].totalCount = WORKLOAD_BUDGETS[workload].maxConnections;
      pools[workload].waitingCount = 4;
    }
    assert.ok(isWorkloadSaturated("public"));
    await shutdownWorkloadClients();
    for (const workload of WORKLOADS) {
      assert.equal(pools[workload].ended, true);
      assert.equal(pools[workload].totalCount, 0);
      assert.equal(pools[workload].waitingCount, 0);
      assert.equal(pools[workload].idleCount, 0);
    }
  } finally {
    await teardown();
  }
});

test("pool stats are immutable snapshots", async () => {
  setup();
  try {
    const stats = getWorkloadPoolStats("public");
    assert.throws(() => {
      (stats as { totalCount: number }).totalCount = 999;
    }, TypeError);
  } finally {
    await teardown();
  }
});
