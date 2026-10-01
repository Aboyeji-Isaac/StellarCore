// Workload-aware database accessor for repositories.
// Provides a way to get a PrismaClient bound to a specific workload class.

import { PrismaClient } from "@/app/generated/prisma/client";
import type { WorkloadClass } from "@/lib/config/workloadBudgets";
import { getWorkloadClient } from "@/lib/db/workloadClient";
import { createMockPrismaClient, isBuildEnvironment } from "@/lib/db/mockClient";

/** Gets a PrismaClient for the specified workload class */
export function getDbForWorkload(workload: WorkloadClass): PrismaClient {
  return getWorkloadClient(workload);
}

/** Default workload for public API routes */
export const PUBLIC_WORKLOAD: WorkloadClass = "public";

/** Default workload for scheduled jobs */
export const SCHEDULED_WORKLOAD: WorkloadClass = "scheduled";

/** Default workload for maintenance operations */
export const MAINTENANCE_WORKLOAD: WorkloadClass = "maintenance";

/** Re-export the default db for backward compatibility (with build-time mock) */
let _db: PrismaClient | undefined;

async function getDefaultDb(): Promise<PrismaClient> {
  if (isBuildEnvironment()) {
    return createMockPrismaClient();
  }
  if (!_db) {
    _db = (await import("@/lib/dbClient")).db;
  }
  return _db;
}

/** Gets the default database client (lazy initialization) */
export async function getDefaultDbClient(): Promise<PrismaClient> {
  return getDefaultDb();
}

/** Legacy export - use getDefaultDbClient() instead */
export const db = new Proxy({} as PrismaClient, {
  get(target, prop, receiver) {
    return Reflect.get(getDefaultDb(), prop, receiver);
  },
});