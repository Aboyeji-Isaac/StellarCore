/**
 * Resolves and validates the connection URL for each runtime role.
 *
 * The application runtime never falls back to migration-owner or operator
 * credentials. Each role reads only its own variable, then the shared runtime
 * variable:
 *
 *   read  : DATABASE_READ_URL  -> DATABASE_URL
 *   write : DATABASE_WRITE_URL -> DATABASE_URL
 *
 * Variables such as `DIRECT_URL`, `PRISMA_DATABASE_URL`, or
 * `MIGRATION_DATABASE_URL` are intentionally ignored.
 *
 * URL query parameters can silently override explicit connection policy because
 * `node-postgres` merges parsed URL parameters over the provided config. Rather
 * than depend on that ordering, this module rejects URL parameters that would
 * conflict with the validated budget, so the budget can never be disabled by a
 * connection string.
 */

import type { DatabaseBudgetProfileName } from "@/lib/db/budget";

export type DatabaseConnectionRole = DatabaseBudgetProfileName;

export type DatabaseConnectionUrlErrorCode =
  | "CONFLICTING_CONNECTION_URL_OPTION"
  | "CONFLICTING_CONNECTION_URL_PARAMETER"
  | "INVALID_CONNECTION_URL"
  | "INVALID_CONNECTION_URL_PROTOCOL"
  | "MISSING_CONNECTION_URL";

export class DatabaseConnectionUrlError extends Error {
  readonly code = "INVALID_DATABASE_CONNECTION_URL";

  constructor(
    readonly reason: DatabaseConnectionUrlErrorCode,
    readonly role: DatabaseConnectionRole,
    readonly variable: string,
  ) {
    super(safeMessage(reason));
    this.name = "DatabaseConnectionUrlError";
  }
}

const ROLE_URL_VARIABLE: Readonly<Record<DatabaseConnectionRole, string>> = Object.freeze({
  read: "DATABASE_READ_URL",
  write: "DATABASE_WRITE_URL",
});

const SHARED_URL_VARIABLE = "DATABASE_URL";

/**
 * URL parameters that would override a bounded policy or the configured
 * `application_name`. They are rejected instead of being silently ignored or
 * silently winning.
 */
const CONFLICTING_PARAMETERS: ReadonlySet<string> = new Set([
  "application_name",
  "connection_limit",
  "idle_in_transaction_session_timeout",
  "lock_timeout",
  "pool_timeout",
  "query_timeout",
  "statement_timeout",
]);

/**
 * Server options can set PostgreSQL GUCs. Reject only budget-related options so
 * unrelated options (for example `search_path`) remain usable.
 */
const BUDGET_GUC_OPTION_PATTERN =
  /(?:^|\s)-c\s*(statement_timeout|lock_timeout|idle_in_transaction_session_timeout|transaction_timeout|default_transaction_read_only)\b/;

const SUPPORTED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

export type DatabaseConnectionUrl = Readonly<{
  role: DatabaseConnectionRole;
  variable: string;
  url: string;
}>;

export function resolveDatabaseConnectionUrl(
  role: DatabaseConnectionRole,
  source: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseConnectionUrl {
  const roleVariable = ROLE_URL_VARIABLE[role];
  const roleValue = source[roleVariable];
  const sharedValue = source[SHARED_URL_VARIABLE];
  const variable = roleValue !== undefined ? roleVariable : SHARED_URL_VARIABLE;
  const raw = roleValue !== undefined ? roleValue : sharedValue;

  if (raw === undefined || raw.trim().length === 0) {
    throw new DatabaseConnectionUrlError("MISSING_CONNECTION_URL", role, variable);
  }

  assertSupportedConnectionUrl(raw, role, variable);

  return Object.freeze({ role, variable, url: raw });
}

export function assertSupportedConnectionUrl(
  raw: string,
  role: DatabaseConnectionRole,
  variable: string,
): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseConnectionUrlError("INVALID_CONNECTION_URL", role, variable);
  }

  if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
    throw new DatabaseConnectionUrlError("INVALID_CONNECTION_URL_PROTOCOL", role, variable);
  }

  for (const parameter of url.searchParams.keys()) {
    if (CONFLICTING_PARAMETERS.has(parameter)) {
      throw new DatabaseConnectionUrlError(
        "CONFLICTING_CONNECTION_URL_PARAMETER",
        role,
        variable,
      );
    }
  }

  const options = url.searchParams.get("options");
  if (options && BUDGET_GUC_OPTION_PATTERN.test(options)) {
    throw new DatabaseConnectionUrlError("CONFLICTING_CONNECTION_URL_OPTION", role, variable);
  }
}

function safeMessage(reason: DatabaseConnectionUrlErrorCode): string {
  switch (reason) {
    case "MISSING_CONNECTION_URL":
      return "A PostgreSQL connection URL is not configured";
    case "INVALID_CONNECTION_URL":
      return "The PostgreSQL connection URL is not a valid URL";
    case "INVALID_CONNECTION_URL_PROTOCOL":
      return "The PostgreSQL connection URL must use postgres:// or postgresql://";
    case "CONFLICTING_CONNECTION_URL_PARAMETER":
      return "The PostgreSQL connection URL contains a parameter that conflicts with the database budget";
    case "CONFLICTING_CONNECTION_URL_OPTION":
      return "The PostgreSQL connection URL options conflict with the database budget";
  }
}
