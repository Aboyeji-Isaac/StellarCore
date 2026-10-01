// Workload-aware database clients providing bulkhead isolation.
// Each workload class gets its own hardened pg.Pool with reserved capacity so
// public traffic, scheduled evidence work, and maintenance cannot starve one
// another, while aggregate capacity stays within the provider limit.

import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { getRuntimeConfig } from "@/lib/config/runtimeConfig";
import {
  WORKLOAD_BUDGETS,
  createWorkloadPoolConfig,
  validateWorkloadBudgets,
  type WorkloadBudgetConfig,
  type WorkloadClass,
} from "@/lib/config/workloadBudgets";
import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";
import {
  createHardenedPool,
  handleConnectionError,
  handlePoolError,
} from "@/lib/db/poolManager";

export type WorkloadClients = Record<WorkloadClass, PrismaClient>;
export type WorkloadPoolFactory = (workload: WorkloadClass) => Pool;

const globalForWorkloadPrisma = globalThis as unknown as {
  workloadClients?: WorkloadClients;
  workloadPools?: Record<WorkloadClass, Pool>;
  workloadPoolFactory?: WorkloadPoolFactory;
};

/** Overrides pool creation in tests; reset with null. */
export function setWorkloadPoolFactoryForTesting(
  factory: WorkloadPoolFactory | null,
): void {
  globalForWorkloadPrisma.workloadPoolFactory = factory ?? undefined;
}

function createWorkloadPool(workload: WorkloadClass): Pool {
  if (globalForWorkloadPrisma.workloadPoolFactory) {
    return globalForWorkloadPrisma.workloadPoolFactory(workload);
  }
  const runtimeConfig = getRuntimeConfig();
  const poolConfig = createWorkloadPoolConfig(workload);
  const tls = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: runtimeConfig.databaseUrl,
    environmentId: runtimeConfig.environment,
    environment: process.env,
  });
  if (!tls.resolution.accepted) {
    const { code, message } = tls.resolution.rejection;
    throw new Error(`Database TLS policy failure (${code}): ${message}`);
  }
  const pool = createHardenedPool(
    tls.sanitizedConnectionString,
    {
      max: poolConfig.max,
      connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
    },
    tls.resolution.mode === "DISABLED" ? undefined : tls.resolution.sslConfig,
  );
  pool.on("connect", (client) => {
    void client.query(`SET statement_timeout = ${poolConfig.statement_timeout}`);
  });
  return pool;
}

function initializeWorkloadClient(workload: WorkloadClass): {
  pool: Pool;
  adapter: PrismaPg;
  client: PrismaClient;
} {
  const pool = createWorkloadPool(workload);
  const adapter = new PrismaPg(pool, {
    onPoolError: (error) => handlePoolError(pool, error),
    onConnectionError: (error) => handleConnectionError(pool, error),
  });
  const client = new PrismaClient({ adapter });
  return { pool, adapter, client };
}

/** Gets or initializes the per-workload Prisma clients (cached per process). */
export function getWorkloadClients(
  budgets: Readonly<Record<WorkloadClass, WorkloadBudgetConfig>> = WORKLOAD_BUDGETS,
): WorkloadClients {
  if (globalForWorkloadPrisma.workloadClients) {
    return globalForWorkloadPrisma.workloadClients;
  }
  validateWorkloadBudgets(budgets);
  const clients: WorkloadClients = {
    public: createLazyClient("public"),
    scheduled: createLazyClient("scheduled"),
    maintenance: createLazyClient("maintenance"),
  };
  globalForWorkloadPrisma.workloadClients = clients;
  return clients;
}

/** Creates a PrismaClient that lazily initializes its pool on first use. */
function createLazyClient(workload: WorkloadClass): PrismaClient {
  let initialized: { pool: Pool; adapter: PrismaPg; client: PrismaClient } | null =
    null;
  return new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      if (!initialized) {
        initialized = initializeWorkloadClient(workload);
        globalForWorkloadPrisma.workloadPools ??= {} as Record<
          WorkloadClass,
          Pool
        >;
        globalForWorkloadPrisma.workloadPools[workload] = initialized.pool;
      }
      return Reflect.get(initialized.client, prop, receiver);
    },
  });
}

/** Gets a PrismaClient for a specific workload class. */
export function getWorkloadClient(workload: WorkloadClass): PrismaClient {
  return getWorkloadClients()[workload];
}

/** Gets the underlying pg.Pool for a workload class (monitoring/health). */
export function getWorkloadPool(workload: WorkloadClass): Pool {
  const client = getWorkloadClient(workload);
  void (client as unknown as Record<PropertyKey, unknown>).$connect;
  const pool = globalForWorkloadPrisma.workloadPools?.[workload];
  if (!pool) {
    throw new Error(`Workload pool for '${workload}' is not initialized`);
  }
  return pool;
}

/** Gets pool statistics for a workload class. */
export function getWorkloadPoolStats(workload: WorkloadClass): Readonly<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}> {
  const pool = getWorkloadPool(workload);
  return Object.freeze({
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  });
}

/** Gets aggregated pool statistics across all workload classes. */
export function getAllWorkloadPoolStats(): Readonly<
  Record<
    WorkloadClass,
    {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      maxConnections: number;
      minConnections: number;
    }
  >
> {
  const clients = getWorkloadClients();
  for (const workload of ["public", "scheduled", "maintenance"] as WorkloadClass[]) {
    void (clients[workload] as unknown as Record<PropertyKey, unknown>).$connect;
  }
  const stats = {} as Record<
    WorkloadClass,
    {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
      maxConnections: number;
      minConnections: number;
    }
  >;
  for (const workload of ["public", "scheduled", "maintenance"] as WorkloadClass[]) {
    const pool = globalForWorkloadPrisma.workloadPools?.[workload];
    const budget = WORKLOAD_BUDGETS[workload];
    stats[workload] = Object.freeze({
      totalCount: pool?.totalCount ?? 0,
      idleCount: pool?.idleCount ?? 0,
      waitingCount: pool?.waitingCount ?? 0,
      maxConnections: budget.maxConnections,
      minConnections: budget.minConnections,
    });
  }
  return Object.freeze(stats);
}

/** Checks if a workload class is saturated (at max connections with waiters). */
export function isWorkloadSaturated(workload: WorkloadClass): boolean {
  const pool = getWorkloadPool(workload);
  const budget = WORKLOAD_BUDGETS[workload];
  return pool.totalCount >= budget.maxConnections && pool.waitingCount > 0;
}

/** Gets the current saturation level (0-1) for a workload class. */
export function getWorkloadSaturation(workload: WorkloadClass): number {
  const pool = getWorkloadPool(workload);
  const budget = WORKLOAD_BUDGETS[workload];
  if (budget.maxConnections === 0) return 0;
  return Math.min(pool.totalCount / budget.maxConnections, 1);
}

/** Gracefully shuts down all workload pools and drops cached clients. */
export async function shutdownWorkloadClients(): Promise<void> {
  if (globalForWorkloadPrisma.workloadPools) {
    await Promise.all(
      Object.values(globalForWorkloadPrisma.workloadPools).map((pool) =>
        pool.end(),
      ),
    );
  }
  globalForWorkloadPrisma.workloadClients = undefined;
  globalForWorkloadPrisma.workloadPools = undefined;
}
