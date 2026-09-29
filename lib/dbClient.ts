import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { observeConnectionPool } from "@/lib/telemetry/core";
import { databaseTelemetryExtension } from "@/lib/telemetry/database";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is not defined");
  }

  let protocol: string;

  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL");
  }

  if (protocol === "prisma:" || protocol === "prisma+postgres:") {
    throw new Error(
      "DATABASE_URL must use postgres:// or postgresql:// with PrismaPg",
    );
  }

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }

  // StellarCore owns the pool so its idle/used/waiting counts can be
  // observed; queueing shows up there before queries time out.
  const pool = new Pool({ connectionString, application_name: "stellarcore" });
  observeConnectionPool("default", pool);
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });

  // The telemetry extension only observes operations; the cast keeps the
  // established PrismaClient type for callers.
  return new PrismaClient({ adapter })
    .$extends(databaseTelemetryExtension("default")) as unknown as PrismaClient;
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
