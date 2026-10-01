// Workload class definitions and connection budget configuration.
// This module implements database bulkhead isolation to prevent
// heavy public-read traffic from exhausting capacity needed by
// scheduled evidence work, and vice versa.

export type WorkloadClass = "public" | "scheduled" | "maintenance";

export type WorkloadBudgetConfig = Readonly<{
  /** Maximum connections reserved for this workload class */
  maxConnections: number;
  /** Minimum connections to keep warm for this workload class */
  minConnections: number;
  /** Maximum time (ms) to wait for a connection from this class's pool */
  acquisitionTimeoutMs: number;
  /** Statement timeout (ms) for queries in this workload class */
  statementTimeoutMs: number;
  /** Whether this workload can borrow from other classes' reserved capacity */
  canBorrow: boolean;
  /** Priority for borrowing (lower = higher priority) */
  borrowPriority: number;
}>;

/** Default database provider limit (e.g., Supabase, Neon, RDS) */
export const DEFAULT_DATABASE_MAX_CONNECTIONS = 100;

/** Workload budget allocations that sum to <= DEFAULT_DATABASE_MAX_CONNECTIONS */
export const WORKLOAD_BUDGETS: Readonly<Record<WorkloadClass, WorkloadBudgetConfig>> = Object.freeze({
  public: {
    maxConnections: 50,
    minConnections: 5,
    acquisitionTimeoutMs: 5_000,
    statementTimeoutMs: 10_000,
    canBorrow: true,
    borrowPriority: 2,
  },
  scheduled: {
    maxConnections: 30,
    minConnections: 3,
    acquisitionTimeoutMs: 30_000,
    statementTimeoutMs: 60_000,
    canBorrow: true,
    borrowPriority: 1,
  },
  maintenance: {
    maxConnections: 10,
    minConnections: 0,
    acquisitionTimeoutMs: 10_000,
    statementTimeoutMs: 30_000,
    canBorrow: false,
    borrowPriority: 0,
  },
});

/** Validates that total reserved capacity doesn't exceed database limit */
export function validateWorkloadBudgets(
  budgets: Readonly<Record<WorkloadClass, WorkloadBudgetConfig>>,
  databaseMaxConnections: number = DEFAULT_DATABASE_MAX_CONNECTIONS,
): void {
  const totalMin = Object.values(budgets).reduce(
    (sum, budget) => sum + budget.minConnections,
    0,
  );
  const totalMax = Object.values(budgets).reduce(
    (sum, budget) => sum + budget.maxConnections,
    0,
  );

  if (totalMin > databaseMaxConnections) {
    throw new Error(
      `Sum of workload minConnections (${totalMin}) exceeds database max connections (${databaseMaxConnections})`,
    );
  }
  if (totalMax > databaseMaxConnections) {
    throw new Error(
      `Sum of workload maxConnections (${totalMax}) exceeds database max connections (${databaseMaxConnections})`,
    );
  }
}

/** Returns the connection string for a workload class (uses same DATABASE_URL) */
export function getWorkloadConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }
  return connectionString;
}

/** Creates a pg.PoolConfig for a specific workload class */
export function createWorkloadPoolConfig(
  workload: WorkloadClass,
  budgets: Readonly<Record<WorkloadClass, WorkloadBudgetConfig>> = WORKLOAD_BUDGETS,
): Readonly<{
  max: number;
  min: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  application_name: string;
}> {
  const budget = budgets[workload];
  return Object.freeze({
    max: budget.maxConnections,
    min: budget.minConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: budget.acquisitionTimeoutMs,
    statement_timeout: budget.statementTimeoutMs,
    application_name: `stellarcore-${workload}`,
  });
}

export const TOTAL_RESERVED_CONNECTIONS = Object.values(WORKLOAD_BUDGETS).reduce(
  (sum, budget) => sum + budget.minConnections,
  0,
);

export const TOTAL_MAX_CONNECTIONS = Object.values(WORKLOAD_BUDGETS).reduce(
  (sum, budget) => sum + budget.maxConnections,
  0,
);

// Validate at module load time
validateWorkloadBudgets(WORKLOAD_BUDGETS);