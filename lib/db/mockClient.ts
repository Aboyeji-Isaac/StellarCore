// Mock PrismaClient for build-time when DATABASE_URL is not available.
// Returns empty results for all queries to allow static generation to proceed.

import { PrismaClient } from "@/app/generated/prisma/client";

type MockDelegate = {
  findUnique: () => Promise<null>;
  findUniqueOrThrow: () => Promise<never>;
  findFirst: () => Promise<null>;
  findFirstOrThrow: () => Promise<never>;
  findMany: () => Promise<readonly unknown[]>;
  create: () => Promise<null>;
  createMany: () => Promise<{ count: number }>;
  createManyAndReturn: () => Promise<readonly unknown[]>;
  update: () => Promise<null>;
  updateMany: () => Promise<{ count: number }>;
  updateManyAndReturn: () => Promise<readonly unknown[]>;
  upsert: () => Promise<null>;
  delete: () => Promise<null>;
  deleteMany: () => Promise<{ count: number }>;
  count: () => Promise<number>;
  aggregate: () => Promise<Record<string, unknown>>;
  groupBy: () => Promise<readonly unknown[]>;
  findRaw: () => Promise<readonly unknown[]>;
  aggregateRaw: () => Promise<Record<string, unknown>>;
};

/** Creates a mock PrismaClient that returns empty results for all queries */
export function createMockPrismaClient(): PrismaClient {
  // Create a minimal mock that returns empty arrays/nulls for all model operations
  const mockClient = {
    $connect: async () => {},
    $disconnect: async () => {},
    $on: () => {},
    $transaction: async <T>(fn: (client: PrismaClient) => Promise<T>): Promise<T> => fn(mockClient),
    $executeRaw: async () => 0,
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    $queryRawUnsafe: async () => [],
    $use: () => {},
    $extends: () => mockClient,
    
    // Model delegates - return empty results
    anchor: createMockDelegate(),
    corridor: createMockDelegate(),
    anchorCorridor: createMockDelegate(),
    rateSnapshot: createMockDelegate(),
    transferOutcome: createMockDelegate(),
    reputationScore: createMockDelegate(),
  } as unknown as PrismaClient;

  return mockClient;
}

/** Creates a mock delegate for a Prisma model */
function createMockDelegate(): MockDelegate {
  const emptyArray = Object.freeze([]);
  const nullResult = null;
  
  return {
    findUnique: async () => nullResult,
    findUniqueOrThrow: async () => { throw new Error("Record not found"); },
    findFirst: async () => nullResult,
    findFirstOrThrow: async () => { throw new Error("Record not found"); },
    findMany: async () => emptyArray,
    create: async () => nullResult,
    createMany: async () => ({ count: 0 }),
    createManyAndReturn: async () => emptyArray,
    update: async () => nullResult,
    updateMany: async () => ({ count: 0 }),
    updateManyAndReturn: async () => emptyArray,
    upsert: async () => nullResult,
    delete: async () => nullResult,
    deleteMany: async () => ({ count: 0 }),
    count: async () => 0,
    aggregate: async () => ({}),
    groupBy: async () => emptyArray,
    findRaw: async () => emptyArray,
    aggregateRaw: async () => ({}),
  };
}

/** Checks if we're in a build environment (no DATABASE_URL) */
export function isBuildEnvironment(): boolean {
  return !process.env.DATABASE_URL && process.env.NODE_ENV !== "test";
}

/** Gets the appropriate PrismaClient for the workload - real or mock */
export function getPrismaClientForWorkload(
  workload: "public" | "scheduled" | "maintenance",
  getRealClient: () => PrismaClient,
): PrismaClient {
  if (isBuildEnvironment()) {
    return createMockPrismaClient();
  }
  return getRealClient();
}