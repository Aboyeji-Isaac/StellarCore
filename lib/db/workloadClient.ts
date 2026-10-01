// Workload-aware database client providing bulkhead isolation.
// Each workload class gets its own connection pool with reserved capacity.

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, PoolConfig } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import type {
  WorkloadClass,
  WorkloadBudgetConfig,
} from "@/lib/config/workloadBudgets";
import {
  WORKLOAD_BUDGETS,
  createWorkloadPoolConfig,
  getWorkloadConnectionString,
  validateWorkloadBudgets,
} from "@/lib/config/workloadBudgets";
import { createMockPrismaClient, isBuildEnvironment } from "@/lib/db/mockClient";

type WorkloadPools = Record<WorkloadClass, Pool>;
type WorkloadAdapters = Record<WorkloadClass, PrismaPg>;
type WorkloadClients = Record<WorkloadClass, PrismaClient>;

/** Global storage for workload-specific Prisma clients */
const globalForWorkloadPrisma = globalThis as unknown as {
  workloadClients: WorkloadClients | undefined;
  workloadPools: WorkloadPools | undefined;
  workloadAdapters: WorkloadAdapters | undefined;
};

/** Creates a pg.Pool for a specific workload class */
function createWorkloadPool(workload: WorkloadClass): Pool {
  const poolConfig = createWorkloadPoolConfig(workload);
  const connectionString = getWorkloadConnectionString();

  const config: PoolConfig = {
    connectionString,
    max: poolConfig.max,
    min: poolConfig.min,
    idleTimeoutMillis: poolConfig.idleTimeoutMillis,
    connectionTimeoutMillis: poolConfig.connectionTimeoutMillis,
    statement_timeout: poolConfig.statement_timeout,
    application_name: poolConfig.application_name,
    // Allow graceful shutdown
    allowExitOnIdle: true,
  };

  return new Pool(config);
}

/** Creates a PrismaPg adapter for a specific workload class */
function createWorkloadAdapter(pool: Pool): PrismaPg {
  return new PrismaPg(pool, {
    disposeExternalPool: true,
  });
}

/** Creates a PrismaClient for a specific workload class */
function createWorkloadClient(adapter: PrismaPg): PrismaClient {
  return new PrismaClient({ adapter });
}

/** Initializes a single workload pool, adapter, and client on demand */
function initializeWorkloadClient(workload: WorkloadClass): { pool: Pool; adapter: PrismaPg; client: PrismaClient } {
  const pool = createWorkloadPool(workload);
  const adapter = createWorkloadAdapter(pool);
  const client = createWorkloadClient(adapter);
  return { pool, adapter, client };
}

/** Gets or initializes the workload-specific Prisma clients */
export function getWorkloadClients(
  budgets: Readonly<Record<WorkloadClass, WorkloadBudgetConfig>> = WORKLOAD_BUDGETS,
): WorkloadClients {
  if (globalForWorkloadPrisma.workloadClients) {
    return globalForWorkloadPrisma.workloadClients;
  }

  // During build, use mock clients to avoid database connections
  if (isBuildEnvironment()) {
    const mockClients: WorkloadClients = {
      public: createMockPrismaClient(),
      scheduled: createMockPrismaClient(),
      maintenance: createMockPrismaClient(),
    };
    if (process.env.NODE_ENV !== "production") {
      globalForWorkloadPrisma.workloadClients = mockClients;
    }
    return mockClients;
  }

  // Validate budgets but don't create pools yet
  validateWorkloadBudgets(budgets);

  // Create a lazy proxy that initializes on first access
  const clients: WorkloadClients = {
    public: createLazyClient("public"),
    scheduled: createLazyClient("scheduled"),
    maintenance: createLazyClient("maintenance"),
  };

  if (process.env.NODE_ENV !== "production") {
    globalForWorkloadPrisma.workloadClients = clients;
  }

  return clients;
}

/** Creates a PrismaClient that lazily initializes its connection pool on first use */
function createLazyClient(workload: WorkloadClass): PrismaClient {
  let initialized: { pool: Pool; adapter: PrismaPg; client: PrismaClient } | null = null;
  
  return new Proxy({} as PrismaClient, {
    get(target, prop, receiver) {
      if (!initialized) {
        initialized = initializeWorkloadClient(workload);
        if (process.env.NODE_ENV !== "production") {
          if (!globalForWorkloadPrisma.workloadPools) {
            globalForWorkloadPrisma.workloadPools = {} as WorkloadPools;
          }
          if (!globalForWorkloadPrisma.workloadAdapters) {
            globalForWorkloadPrisma.workloadAdapters = {} as WorkloadAdapters;
          }
          globalForWorkloadPrisma.workloadPools![workload] = initialized.pool;
          globalForWorkloadPrisma.workloadAdapters![workload] = initialized.adapter;
        }
      }
      return Reflect.get(initialized.client, prop, receiver);
    },
  });
}

/** Gets a PrismaClient for a specific workload class */
export function getWorkloadClient(workload: WorkloadClass): PrismaClient {
  const clients = getWorkloadClients();
  return clients[workload];
}

/** Gets the underlying pg.Pool for a workload class (for monitoring/health checks) */
export function getWorkloadPool(workload: WorkloadClass): Pool {
  // Force initialization by accessing the client
  getWorkloadClient(workload);
  return globalForWorkloadPrisma.workloadPools![workload];
}

/** Gets pool statistics for a workload class */
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

/** Gets aggregated pool statistics across all workload classes */
export function getAllWorkloadPoolStats(): Readonly<Record<WorkloadClass, {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
  maxConnections: number;
  minConnections: number;
}>> {
  getWorkloadClients(); // Ensure initialization
  const stats: Record<WorkloadClass, {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
    maxConnections: number;
    minConnections: number;
  }> = {
    public: { totalCount: 0, idleCount: 0, waitingCount: 0, maxConnections: 0, minConnections: 0 },
    scheduled: { totalCount: 0, idleCount: 0, waitingCount: 0, maxConnections: 0, minConnections: 0 },
    maintenance: { totalCount: 0, idleCount: 0, waitingCount: 0, maxConnections: 0, minConnections: 0 },
  };

  for (const workload of ["public", "scheduled", "maintenance"] as WorkloadClass[]) {
    const pool = globalForWorkloadPrisma.workloadPools![workload];
    const budget = WORKLOAD_BUDGETS[workload];
    stats[workload] = Object.freeze({
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
      maxConnections: budget.maxConnections,
      minConnections: budget.minConnections,
    });
  }

  return stats;
}

/** Gracefully shuts down all workload pools */
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
  globalForWorkloadPrisma.workloadAdapters = undefined;
}

/** Checks if a workload class is saturated (at max connections with waiters) */
export function isWorkloadSaturated(workload: WorkloadClass): boolean {
  const pool = getWorkloadPool(workload);
  const budget = WORKLOAD_BUDGETS[workload];
  return pool.totalCount >= budget.maxConnections && pool.waitingCount > 0;
}

/** Gets the current saturation level (0-1) for a workload class */
export function getWorkloadSaturation(workload: WorkloadClass): number {
  const pool = getWorkloadPool(workload);
  const budget = WORKLOAD_BUDGETS[workload];
  if (budget.maxConnections === 0) return 0;
  return Math.min(pool.totalCount / budget.maxConnections, 1);
}