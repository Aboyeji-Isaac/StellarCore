/**
 * Process-scoped runtime database clients.
 *
 * One bounded client/pool is created lazily per role and reused for the whole
 * process. Nothing here is scoped to a request, and request handlers must not
 * call `$disconnect()`. Long-lived CLI entrypoints call
 * `disconnectRuntimeDatabaseClients()` once on shutdown.
 */

import type { PrismaClient } from "@/app/generated/prisma/client";
import {
  parseDatabaseBudgetConfiguration,
  type DatabaseBudget,
  type DatabaseBudgetConfiguration,
} from "@/lib/db/budget";
import {
  createBoundedDatabaseClient,
  type BoundedDatabaseClient,
} from "@/lib/db/connection";
import { resolveDatabaseConnectionUrl } from "@/lib/db/connectionUrl";
import type { DatabaseConnectionRole } from "@/lib/db/connectionUrl";
import type { DatabaseResourceError } from "@/lib/db/errors";

export type DatabaseClientRole = DatabaseConnectionRole;

type RuntimeCache = {
  __stellarcoreDatabaseClients?: Partial<Record<DatabaseClientRole, BoundedDatabaseClient>>;
};

const moduleCache: Partial<Record<DatabaseClientRole, BoundedDatabaseClient>> = {};
const globalCache = globalThis as unknown as RuntimeCache;

let cachedConfiguration: DatabaseBudgetConfiguration | undefined;
const lastPoolErrors: Partial<Record<DatabaseClientRole, DatabaseResourceError>> = {};

export function getDatabaseBudgetConfiguration(): DatabaseBudgetConfiguration {
  cachedConfiguration ??= parseDatabaseBudgetConfiguration(process.env);
  return cachedConfiguration;
}

export function getDatabaseBudget(role: DatabaseClientRole): DatabaseBudget {
  return getDatabaseBudgetConfiguration()[role];
}

export function getRuntimeDatabaseClient(role: DatabaseClientRole): BoundedDatabaseClient {
  const existing = moduleCache[role]
    ?? (process.env.NODE_ENV !== "production" ? globalCache.__stellarcoreDatabaseClients?.[role] : undefined);
  if (existing) {
    moduleCache[role] = existing;
    return existing;
  }

  const budget = getDatabaseBudget(role);
  const { url } = resolveDatabaseConnectionUrl(role);
  const created = createBoundedDatabaseClient({
    role,
    connectionString: url,
    budget,
    onPoolError: (error) => {
      lastPoolErrors[role] = error;
    },
  });

  moduleCache[role] = created;
  if (process.env.NODE_ENV !== "production") {
    globalCache.__stellarcoreDatabaseClients = {
      ...globalCache.__stellarcoreDatabaseClients,
      [role]: created,
    };
  }
  return created;
}

export function getReadDatabaseClient(): PrismaClient {
  return getRuntimeDatabaseClient("read").client;
}

export function getWriteDatabaseClient(): PrismaClient {
  return getRuntimeDatabaseClient("write").client;
}

/** Last pool/connection error for a role, already translated and secret-free. */
export function getLastDatabasePoolError(
  role: DatabaseClientRole,
): DatabaseResourceError | undefined {
  return lastPoolErrors[role];
}

/**
 * Drains every runtime pool that has been created in this process. Intended for
 * explicit CLI/script shutdown, never for request completion.
 */
export async function disconnectRuntimeDatabaseClients(): Promise<void> {
  const clients = new Set<BoundedDatabaseClient>([
    ...Object.values(moduleCache).filter(isClient),
    ...Object.values(globalCache.__stellarcoreDatabaseClients ?? {}).filter(isClient),
  ]);
  await Promise.all([...clients].map((entry) => entry.client.$disconnect()));
}

function isClient(
  entry: BoundedDatabaseClient | undefined,
): entry is BoundedDatabaseClient {
  return entry !== undefined;
}
