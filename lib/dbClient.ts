import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { parseBudgetConfigFromEnv } from "@/lib/db/budgetConfig";
import { createBudgetPool } from "@/lib/db/pool";

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

  // Parse and validate the database budget from environment variables.
  // This throws DatabaseBudgetConfigError on any invalid, non-finite,
  // or out-of-range value — the budget is never silently disabled.
  const budgetConfig = parseBudgetConfigFromEnv();

  // Create a bounded pg.Pool with server-side statement/lock timeouts.
  const pool = createBudgetPool(connectionString, budgetConfig);

  const adapter = new PrismaPg(pool);

  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
