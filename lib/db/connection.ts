import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/app/generated/prisma/client";

/**
 * Runtime database privilege classes. The migration owner is deliberately not
 * a runtime role: only the Prisma CLI (prisma.config.ts) and the reviewed
 * grant tooling read MIGRATION_DATABASE_URL.
 */
export type RuntimeDatabaseRole = "read" | "write";

export const RUNTIME_DATABASE_URL_ENV = Object.freeze({
  read: "DATABASE_READ_URL",
  write: "DATABASE_WRITE_URL",
} as const satisfies Record<RuntimeDatabaseRole, string>);

export const MIGRATION_DATABASE_URL_ENV = "MIGRATION_DATABASE_URL";

/**
 * Credentials that must never reach a production runtime process. The legacy
 * single DATABASE_URL is included because it historically held the migration
 * owner credential.
 */
const FORBIDDEN_PRODUCTION_RUNTIME_ENV = Object.freeze([
  MIGRATION_DATABASE_URL_ENV,
  "DATABASE_URL",
]);

export type DatabaseConfigurationErrorCode =
  | "DATABASE_URL_MISSING"
  | "DATABASE_URL_INVALID"
  | "DATABASE_URL_UNSUPPORTED_PROTOCOL"
  | "DATABASE_PRIVILEGED_URL_IN_RUNTIME"
  | "DATABASE_ROLES_NOT_SEPARATED";

/**
 * Bounded configuration error. Messages name environment variables only and
 * never include connection strings, user names, hosts, or passwords.
 */
export class DatabaseConfigurationError extends Error {
  readonly code: DatabaseConfigurationErrorCode;

  constructor(code: DatabaseConfigurationErrorCode, message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
    this.code = code;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the connection string for exactly one runtime role. There is no
 * fallback: a missing read URL never resolves to the writer, the migration
 * owner, or the legacy DATABASE_URL.
 */
export function resolveRuntimeDatabaseUrl(
  role: RuntimeDatabaseRole,
  env: Environment = process.env,
): string {
  const name = RUNTIME_DATABASE_URL_ENV[role];
  const connectionString = env[name];
  parsePostgresUrl(name, connectionString);

  if (env.NODE_ENV === "production") {
    for (const forbidden of FORBIDDEN_PRODUCTION_RUNTIME_ENV) {
      if (env[forbidden]) {
        throw new DatabaseConfigurationError(
          "DATABASE_PRIVILEGED_URL_IN_RUNTIME",
          `${forbidden} must not be configured for the production application runtime`,
        );
      }
    }

    const otherRole: RuntimeDatabaseRole = role === "read" ? "write" : "read";
    const otherName = RUNTIME_DATABASE_URL_ENV[otherRole];
    const other = env[otherName];
    if (other && sameDatabaseUser(connectionString as string, other)) {
      throw new DatabaseConfigurationError(
        "DATABASE_ROLES_NOT_SEPARATED",
        `${RUNTIME_DATABASE_URL_ENV.read} and ${RUNTIME_DATABASE_URL_ENV.write} must use different database roles in production`,
      );
    }
  }

  return connectionString as string;
}

export function createRuntimePrismaClient(
  role: RuntimeDatabaseRole,
  env: Environment = process.env,
): PrismaClient {
  const connectionString = resolveRuntimeDatabaseUrl(role, env);
  const adapter = new PrismaPg({
    connectionString,
    application_name: `stellarcore-${role}`,
  });

  return new PrismaClient({ adapter });
}

function parsePostgresUrl(name: string, value: string | undefined): URL {
  if (!value) {
    throw new DatabaseConfigurationError(
      "DATABASE_URL_MISSING",
      `${name} is not defined`,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DatabaseConfigurationError(
      "DATABASE_URL_INVALID",
      `${name} must be a valid PostgreSQL connection URL`,
    );
  }

  if (url.protocol === "prisma:" || url.protocol === "prisma+postgres:") {
    throw new DatabaseConfigurationError(
      "DATABASE_URL_UNSUPPORTED_PROTOCOL",
      `${name} must use postgres:// or postgresql:// with PrismaPg`,
    );
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigurationError(
      "DATABASE_URL_UNSUPPORTED_PROTOCOL",
      `${name} must use postgres:// or postgresql://`,
    );
  }

  return url;
}

function sameDatabaseUser(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.username !== "" &&
      decodeURIComponent(leftUrl.username) === decodeURIComponent(rightUrl.username) &&
      leftUrl.host === rightUrl.host;
  } catch {
    return false;
  }
}
