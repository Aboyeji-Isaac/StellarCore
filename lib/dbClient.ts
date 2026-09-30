import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";
import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";

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

  const tls = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: connectionString,
    environment: process.env,
  });

  if (!tls.resolution.accepted) {
    const { code, message } = tls.resolution.rejection;
    // Diagnostics identify the policy failure without printing the URL,
    // credentials, or certificate material.
    throw new Error(`Database TLS policy failure (${code}): ${message}`);
  }

  if (tls.emergencyBypassActive) {
    // One safe line identifying an active bypass; no credential material.
    console.warn(
      "Database TLS: certificate-verification emergency bypass is ACTIVE for this process.",
    );
  }

  const adapter = new PrismaPg({
    connectionString: tls.sanitizedConnectionString,
    ssl: tls.resolution.sslConfig,
  });

  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
