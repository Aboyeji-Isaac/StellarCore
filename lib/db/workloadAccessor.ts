// Workload-aware database accessor for repositories.

import { PrismaClient } from "@/app/generated/prisma/client";
import type { WorkloadClass } from "@/lib/config/workloadBudgets";
import { getWorkloadClient } from "@/lib/db/workloadClient";

/** Gets a PrismaClient for the specified workload class. */
export function getDbForWorkload(workload: WorkloadClass): PrismaClient {
  return getWorkloadClient(workload);
}

/** Default workload for public API routes. */
export const PUBLIC_WORKLOAD: WorkloadClass = "public";

/** Default workload for scheduled jobs. */
export const SCHEDULED_WORKLOAD: WorkloadClass = "scheduled";

/** Default workload for maintenance operations. */
export const MAINTENANCE_WORKLOAD: WorkloadClass = "maintenance";
