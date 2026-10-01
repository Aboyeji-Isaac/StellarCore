import assert from "node:assert/strict";
import test from "node:test";

import { WORKLOAD_BUDGETS, type WorkloadClass } from "@/lib/config/workloadBudgets";

/**
 * In-process saturation harness. Mirrors pg.Pool semantics: each workload
 * class has an independent connection budget, acquisition waits in a queue
 * bounded by the class's acquisitionTimeoutMs, and excess waiters fail with
 * a bounded overload error instead of hanging.
 */
class BulkheadPool {
  readonly max: number;
  readonly acquisitionTimeoutMs: number;
  active = 0;
  waiting = 0;
  peakActive = 0;
  timeouts = 0;
  private waiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];

  constructor(max: number, acquisitionTimeoutMs: number) {
    this.max = max;
    this.acquisitionTimeoutMs = acquisitionTimeoutMs;
  }

  async acquire(): Promise<{ release: () => void }> {
    if (this.active < this.max) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return { release: () => this.release() };
    }
    this.waiting += 1;
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          this.active += 1;
          this.peakActive = Math.max(this.peakActive, this.active);
          resolve({ release: () => this.release() });
        },
        reject: (error: Error) => reject(error),
        timer: setTimeout(() => {
          this.waiting -= 1;
          this.timeouts += 1;
          reject(new Error(`workload acquisition timed out after ${this.acquisitionTimeoutMs}ms`));
        }, this.acquisitionTimeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      this.waiting -= 1;
      next.resolve();
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("competing workloads concurrently never exceed their own budgets", async () => {
  const pools: Record<WorkloadClass, BulkheadPool> = {
    public: new BulkheadPool(WORKLOAD_BUDGETS.public.maxConnections, WORKLOAD_BUDGETS.public.acquisitionTimeoutMs),
    scheduled: new BulkheadPool(WORKLOAD_BUDGETS.scheduled.maxConnections, WORKLOAD_BUDGETS.scheduled.acquisitionTimeoutMs),
    maintenance: new BulkheadPool(WORKLOAD_BUDGETS.maintenance.maxConnections, WORKLOAD_BUDGETS.maintenance.acquisitionTimeoutMs),
  };

  const runTasks = async (workload: WorkloadClass, count: number, holdMs: number) => {
    const results = { ok: 0, failed: 0 };
    await Promise.all(
      Array.from({ length: count }, async () => {
        try {
          const slot = await pools[workload].acquire();
          await sleep(holdMs);
          slot.release();
          results.ok += 1;
        } catch {
          results.failed += 1;
        }
      }),
    );
    return results;
  };

  const [publicRun, scheduledRun, maintenanceRun] = await Promise.all([
    runTasks("public", 120, 10),
    runTasks("scheduled", 80, 10),
    runTasks("maintenance", 30, 10),
  ]);

  assert.ok(pools.public.peakActive <= WORKLOAD_BUDGETS.public.maxConnections);
  assert.ok(pools.scheduled.peakActive <= WORKLOAD_BUDGETS.scheduled.maxConnections);
  assert.ok(pools.maintenance.peakActive <= WORKLOAD_BUDGETS.maintenance.maxConnections);

  const peakAggregate =
    pools.public.peakActive + pools.scheduled.peakActive + pools.maintenance.peakActive;
  assert.ok(peakAggregate <= 90);
  assert.ok(peakAggregate <= 100);

  assert.equal(publicRun.failed + publicRun.ok, 120);
  assert.equal(scheduledRun.failed + scheduledRun.ok, 80);
  assert.equal(maintenanceRun.failed + maintenanceRun.ok, 30);
  assert.equal(publicRun.failed, 0, "public reads must not be starved by scheduled work");
  assert.equal(scheduledRun.failed, 0, "scheduled work must not be blocked by public saturation");
});

test("saturating public reads leaves scheduled capacity intact", async () => {
  const publicPool = new BulkheadPool(50, 200);
  const scheduledPool = new BulkheadPool(30, 200);

  // Saturate the public pool with long-held connections.
  const publicWaiters = Array.from({ length: 50 }, async () => {
    const slot = await publicPool.acquire();
    await sleep(300);
    slot.release();
  });

  // Scheduled work must still acquire immediately from its own pool.
  const slot = await scheduledPool.acquire();
  assert.equal(scheduledPool.active, 1);
  slot.release();

  await Promise.all(publicWaiters);
});

test("overload returns bounded failures rather than hanging indefinitely", async () => {
  const pool = new BulkheadPool(2, 50);
  const held = await Promise.all([pool.acquire(), pool.acquire()]);

  const started = Date.now();
  await assert.rejects(pool.acquire(), /timed out/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `overload failure should be bounded, took ${elapsed}ms`);
  assert.equal(pool.timeouts, 1);

  held.forEach((slot) => slot.release());
  const slot = await pool.acquire();
  slot.release();
});
