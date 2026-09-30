import {
  assertProductionDatabaseIdentityTableIdentifier,
  auditProductionDatabaseIdentity,
  parseProductionDatabaseTarget,
  type ProductionDatabaseIdentityAuditResult,
  type ProductionDatabaseIdentityIssue,
  type ProductionDatabaseIdentityIssueCode,
} from "@/lib/config/productionDatabaseIdentity";
import { resolveExpectedProductionDatabaseTarget } from "@/lib/config/currentProductionDatabaseIdentity";
import type {
  ProductionDatabaseServerObservation,
  ProductionDatabaseTargetIdentity,
} from "@/types/productionDatabaseIdentity";

/**
 * Read-only preflight that proves a credential points at the reviewed
 * production database before any privileged workflow mutates it.
 *
 * Design constraints, all of them load-bearing:
 *
 * - **Read-only.** The probe runs inside `BEGIN TRANSACTION READ ONLY` and the
 *   server-reported `transaction_read_only` setting is verified before the
 *   result is trusted. A server that cannot honour read-only is a halt, not a
 *   warning, so the preflight can never itself change data.
 * - **No credentials in or out.** The connection string is used only to open
 *   the socket. The result is projected from the parsed URL's host, port, and
 *   database name plus `current_database()`, `inet_server_addr()`,
 *   `inet_server_port()`, `pg_is_in_recovery()`, and the marker row. A password
 *   or username is not representable in the output type.
 * - **No raw driver error text.** Connection and query failures collapse to a
 *   single `PRODUCTION_DATABASE_OBSERVATION_FAILED` code, because a libpq
 *   error can embed the DSN. The cause is counted, never forwarded.
 * - **Bounded time.** Connection and statement timeouts are set so a preflight
 *   can never hang a privileged job until the workflow-level timeout.
 *
 * The probe uses a dedicated `pg` client rather than the shared Prisma client
 * because it must also work before migrations have ever been applied to a
 * freshly provisioned database, when there is no schema to talk about yet.
 */

const PREFLIGHT_CONNECTION_TIMEOUT_MS = 5_000;
const PREFLIGHT_STATEMENT_TIMEOUT_MS = 5_000;

const OBSERVATION_SQL =
  "SELECT current_database() AS database_name, " +
  "current_setting('transaction_read_only') AS transaction_read_only, " +
  // `host()` strips the netmask that a bare `inet_server_addr()::text` cast
  // would include on Linux, so the fingerprint depends only on the address and
  // not on how a given platform renders the netmask.
  "coalesce(host(inet_server_addr()), '') AS server_address, " +
  "coalesce(inet_server_port()::text, '') AS server_port, " +
  "pg_is_in_recovery() AS in_recovery";

/**
 * The minimal `pg` client surface used here, so a test can inject a stub.
 *
 * `connect()` is declared as returning `Promise<unknown>` because `pg` resolves
 * with the client itself rather than with `void`; the probe ignores the value.
 */
export type ProductionDatabaseQueryClient = Readonly<{
  connect: () => Promise<unknown>;
  query: (text: string, values?: readonly unknown[]) => Promise<{ rows: readonly unknown[] }>;
  end: () => Promise<void>;
}>;

export type ProductionDatabaseClientFactory = (
  connectionString: string,
) => Promise<ProductionDatabaseQueryClient>;

/**
 * What the probe learns from the server. The URL-derived target is
 * deliberately absent: it is filled in by `runPreflight` from the parsed
 * connection string so a stub observer cannot assert its own expectation.
 */
export type ProductionDatabaseServerProbe = Readonly<{
  server: ProductionDatabaseServerObservation;
  /** `true` when the marker relation exists on this database. */
  identityTablePresent: boolean;
  /** Marker value read from the singleton row, or `null` when absent. */
  marker: string | null;
}>;

export type ProductionDatabaseObserver = (
  connectionString: string,
  options: Readonly<{ markerRowKey: string }>,
) => Promise<Readonly<{ ok: true; probe: ProductionDatabaseServerProbe } | { ok: false }>>;

export type ProductionDatabasePreflightDependencies = Readonly<{
  connectionString?: string;
  /** Overrides the checked-in expectation. `null` means "no expectation". */
  expected?: ProductionDatabaseTargetIdentity | null;
  environment?: Readonly<Record<string, string | undefined>>;
  observe?: ProductionDatabaseObserver;
  createClient?: ProductionDatabaseClientFactory;
}>;

export type ProductionDatabasePreflightResult = Readonly<{
  ok: boolean;
  action: "continue" | "halt";
  targetId: string | null;
  configured: ProductionDatabaseIdentityAuditResult["configured"];
  observed: ProductionDatabaseIdentityAuditResult["observed"];
  fingerprint: string | null;
  fingerprintApproved: boolean;
  provisioned: boolean;
  issues: readonly ProductionDatabaseIdentityIssue[];
}>;

type ExpectedResolution =
  | Readonly<{ ok: true; target: ProductionDatabaseTargetIdentity }>
  | Readonly<{ ok: false; code: string }>;

/**
 * Runs the guard.
 *
 * Expected failures never throw: a malformed URL, an unreachable host, an
 * unusable registry, and a wrong target all resolve to a halted result, so the
 * calling workflow receives a readable, credential-free diagnostic and a nonzero
 * exit code. Only an outright programming error escapes.
 */
export async function runPreflight(
  dependencies: ProductionDatabasePreflightDependencies = {},
): Promise<ProductionDatabasePreflightResult> {
  const environment = dependencies.environment ?? process.env;
  const connectionString = dependencies.connectionString ?? environment.DATABASE_URL ?? "";

  const parsed = parseProductionDatabaseTarget(connectionString);
  if (!parsed.ok) return halted([{ code: parsed.code, field: "observation" }]);

  const expected = resolveExpected(dependencies, environment);
  if (!expected.ok) {
    return halted([{ code: expected.code as ProductionDatabaseIdentityIssueCode, field: "expected" }]);
  }

  const observe = dependencies.observe ?? createObserver(dependencies.createClient);
  const probed = await observe(connectionString, {
    markerRowKey: expected.target.marker.rowKey,
  });
  if (!probed.ok) {
    return halted([{ code: "PRODUCTION_DATABASE_OBSERVATION_FAILED", field: "observation" }], {
      targetId: expected.target.id,
    });
  }

  const result = auditProductionDatabaseIdentity({
    expected: expected.target,
    observation: { target: parsed.target, ...probed.probe },
  });

  return Object.freeze({
    ok: result.ok,
    action: result.action,
    targetId: result.targetId,
    configured: result.configured,
    observed: result.observed,
    fingerprint: result.fingerprint,
    fingerprintApproved: result.fingerprintApproved,
    provisioned: result.provisioned,
    issues: result.issues,
  });
}

/**
 * The real probe: a short-lived, read-only connection that reports the server's
 * own view of itself plus the marker row.
 */
export function createObserver(
  createClient: ProductionDatabaseClientFactory = defaultClientFactory,
): ProductionDatabaseObserver {
  return async (connectionString, { markerRowKey }) => {
    let client: ProductionDatabaseQueryClient;
    try {
      client = await createClient(connectionString);
    } catch {
      return { ok: false };
    }

    let connected = false;
    let transactionOpen = false;
    try {
      // `pg` does not open a socket until `connect()` is called; querying first
      // queues behind a connection that never arrives.
      await client.connect();
      connected = true;

      await client.query("BEGIN TRANSACTION READ ONLY");
      transactionOpen = true;

      const server = await readServerIdentity(client);
      if (server === null) return { ok: false };

      const { identityTablePresent, marker } = await readMarker(client, markerRowKey);

      await client.query("COMMIT");
      transactionOpen = false;

      return Object.freeze({
        ok: true,
        probe: Object.freeze({ server, identityTablePresent, marker }),
      });
    } catch {
      if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined);
      return { ok: false };
    } finally {
      // `end()` is safe to call only after `connect()` succeeded; calling it on a
      // client that never connected throws and would mask the real failure.
      if (connected) await client.end().catch(() => undefined);
    }
  };
}

const defaultClientFactory: ProductionDatabaseClientFactory = async (connectionString) => {
  const { Client } = await import("pg");
  return new Client({
    connectionString,
    connectionTimeoutMillis: PREFLIGHT_CONNECTION_TIMEOUT_MS,
    statement_timeout: PREFLIGHT_STATEMENT_TIMEOUT_MS,
    application_name: "stellarcore-production-db-preflight",
  });
};

/**
 * Reads the server-reported identity. `transaction_read_only` is read inside the
 * probe transaction, so the read-only guarantee is verified on the very
 * connection that produced the rest of the observation rather than assumed.
 */
async function readServerIdentity(
  client: ProductionDatabaseQueryClient,
): Promise<ProductionDatabaseServerObservation | null> {
  const { rows } = await client.query(OBSERVATION_SQL);
  const row = rows[0] as
    | Readonly<{
        database_name?: unknown;
        transaction_read_only?: unknown;
        server_address?: unknown;
        server_port?: unknown;
        in_recovery?: unknown;
      }>
    | undefined;
  if (row === undefined) return null;

  const databaseName = typeof row.database_name === "string" ? row.database_name : "";
  if (databaseName === "") return null;

  const address = typeof row.server_address === "string" ? row.server_address : "";
  const portText = typeof row.server_port === "string" ? row.server_port : "";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : null;

  return Object.freeze({
    databaseName,
    readOnly: row.transaction_read_only === "on",
    // An empty `inet_server_addr()` means a Unix-domain socket connection, which
    // exposes no verifiable network identity. It is represented as `null` so the
    // fingerprint becomes unverifiable and the audit halts rather than passes.
    serverAddress: address === "" ? null : address,
    serverPort: address === "" ? null : port,
    inRecovery: row.in_recovery === true,
  });
}

/**
 * Reads the marker row when the relation exists.
 *
 * The relation name is a checked-in constant validated as two plain identifiers
 * before interpolation, and the row key is always passed as a bound value, so
 * nothing executable can arrive through either.
 */
async function readMarker(
  client: ProductionDatabaseQueryClient,
  markerRowKey: string,
): Promise<Readonly<{ identityTablePresent: boolean; marker: string | null }>> {
  const relation = assertProductionDatabaseIdentityTableIdentifier();

  const presence = await client.query(
    `SELECT to_regclass('${relation}') IS NOT NULL AS present`,
  );
  const present = (presence.rows[0] as Readonly<{ present?: unknown }> | undefined)?.present === true;
  if (!present) return Object.freeze({ identityTablePresent: false, marker: null });

  const { rows } = await client.query(
    `SELECT marker FROM ${relation} WHERE row_key = $1`,
    Object.freeze([markerRowKey]),
  );
  const row = rows[0] as Readonly<{ marker?: unknown }> | undefined;
  return Object.freeze({
    identityTablePresent: true,
    marker: typeof row?.marker === "string" ? row.marker : null,
  });
}

function resolveExpected(
  dependencies: ProductionDatabasePreflightDependencies,
  environment: Readonly<Record<string, string | undefined>>,
): ExpectedResolution {
  if (dependencies.expected === null) {
    return { ok: false, code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING" };
  }
  if (dependencies.expected !== undefined) {
    return { ok: true, target: dependencies.expected };
  }

  const resolved = resolveExpectedProductionDatabaseTarget(environment);
  return resolved.ok ? { ok: true, target: resolved.target } : { ok: false, code: resolved.code };
}

function halted(
  issues: readonly ProductionDatabaseIdentityIssue[],
  extra: Readonly<{ targetId?: string | null }> = {},
): ProductionDatabasePreflightResult {
  return Object.freeze({
    ok: false,
    action: "halt",
    targetId: extra.targetId ?? null,
    configured: Object.freeze({ host: null, port: null, database: null }),
    observed: Object.freeze({
      database: null,
      serverAddress: null,
      serverPort: null,
      inRecovery: null,
      readOnly: null,
    }),
    fingerprint: null,
    fingerprintApproved: false,
    provisioned: false,
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
  });
}
