import "server-only";
import { PrismaClient } from "@/app/generated/prisma/client";
import { createMockPrismaClient, isBuildEnvironment } from "@/lib/db/mockClient";

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

export const db = new Proxy({} as PrismaClient, {
  get(target, prop, receiver) {
    return Reflect.get(getDefaultDb(), prop, receiver);
  },
});

export {
  getWorkloadClient,
  getWorkloadPool,
  getWorkloadPoolStats,
  getAllWorkloadPoolStats,
  shutdownWorkloadClients,
  isWorkloadSaturated,
  getWorkloadSaturation,
} from "@/lib/db/workloadClient";
