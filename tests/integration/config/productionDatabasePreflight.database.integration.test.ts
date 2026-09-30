import assert from "node:assert/strict";
import test from "node:test";

import {
  computeProductionDatabaseFingerprint,
  type ProductionDatabaseIdentityIssueCode,
} from "@/lib/config/productionDatabaseIdentity";
import { runPreflight } from "@/lib/config/productionDatabasePreflight";
import type { ProductionDatabaseTargetIdentity } from "@/types/productionDatabaseIdentity";

/**
 * Live-database coverage for the production target-identity preflight.
 *
 * The unit suite drives the probe with an injected client. This file exercises
 * the real `pg` path against a real PostgreSQL server, because the properties
 * that matter most here are properties of the server, not of our SQL:
 *
 *   - `BEGIN TRANSACTION READ ONLY` really does report
 *     `transaction_read_only = on`, so the probe really is read-only.
 *   - `current_database()` is the server's own answer, which is what lets the
 *     name check reject a URL that merely claims the right name.
 *   - `inet_server_addr()` and `inet_server_port()` are `null` over a Unix
 *     socket, which is why a socket endpoint halts as unverifiable.
 *
 * Every case is built by creating a throwaway database on the same live server,
 * so the credential is genuinely valid and the connection genuinely succeeds.
 * That is the shape of the failure this guard exists for: a working credential
 * pointed at the wrong database.
 *
 * Opt in with `RUN_PRODUCTION_DATABASE_PREFLIGHT_INTEGRATION=1` and point
 * `DATABASE_URL` at a disposable database on a server you do not mind writing
 * scratch databases to. It is never part of `npm test`, the build, or
 * postinstall.
 */

const ENABLED = process.env.RUN_PRODUCTION_DATABASE_PREFLIGHT_INTEGRATION === "1";

const MARKER_VALUE = "STELLARCORE_PRODUCTION_DATABASE_V1";

/**
 * A dedicated login role with a distinctive name and password.
 *
 * The default PostgreSQL install uses `postgres` for both the superuser and the
 * maintenance database, which would make a credential-leak assertion ambiguous:
 * the string `postgres` legitimately appears in a reported database name. Using
 * a role that cannot collide with any reported field makes the leak check
 * unambiguous, and lets the scratch databases prove that a genuinely
 * authenticated, non-superuser credential is still rejected on identity.
 */
const PROBE_ROLE = "stellarcore_preflight_role";
const PROBE_PASSWORD = "stellarcore-preflight-secret";

test("the preflight continues against a correctly identified live database", {
  skip: !ENABLED,
}, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    await applyMarker(scratch.url, MARKER_VALUE);

    // The reviewed identity is derived from the live server and pointed at the
    // scratch database, so every dimension agrees: the host the URL used, the
    // database the server reports, the cluster fingerprint, and the marker.
    const expected = targetFor({ ...live, database: scratch.name });
    const result = await runPreflight({ connectionString: scratch.url, expected });

    assert.deepEqual(result.issues, []);
    assert.equal(result.ok, true);
    assert.equal(result.action, "continue");
    assert.equal(result.fingerprintApproved, true);
    assert.equal(result.provisioned, true);
    assert.equal(result.observed.readOnly, true, "the probe must run read-only");
    assert.equal(result.observed.inRecovery, false);
    assert.equal(result.observed.database, scratch.name);
    assert.equal(result.fingerprint, expected.clusterFingerprints[0]);
    assert.equal(
      result.observed.serverAddress,
      live.serverAddress,
      "the fingerprint must come from the server, not from the URL text",
    );
    assert.equal(containsCredential(result), false);
  });
});

test("a valid credential on a different live database halts before mutation", {
  skip: !ENABLED,
}, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    await applyMarker(scratch.url, MARKER_VALUE);

    // The credential is valid, the connection succeeds, and the scratch
    // database even carries the right marker. Only the reviewed database
    // identity can stop the mutation, and it must.
    const result = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor(live),
    });

    assert.equal(result.ok, false);
    assert.equal(result.action, "halt");
    assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_NAME_MISMATCH"));
    assert.equal(containsCredential(result), false);
  });
});

test("a live database with a wrong marker halts", { skip: !ENABLED }, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    await applyMarker(scratch.url, "STELLARCORE_SOME_OTHER_DATABASE_V1");

    const result = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor({ ...live, database: scratch.name }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.provisioned, true);
    assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_MARKER_MISMATCH"]);
  });
});

test("a live database with no marker row halts once provisioned", { skip: !ENABLED }, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    // The relation exists but the reviewed row does not, which is a different
    // failure from "never migrated" and must not be waved through.
    await exec(scratch.url, "CREATE TABLE public.production_database_identity ("
      + "row_key TEXT PRIMARY KEY, marker TEXT NOT NULL)");

    const result = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor({ ...live, database: scratch.name }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.provisioned, true);
    assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);
  });
});

test("a live database without the marker relation is unprovisioned, not accepted", {
  skip: !ENABLED,
}, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    const rejected = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor({ ...live, database: scratch.name }),
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.provisioned, false);
    assert.deepEqual(codes(rejected.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);

    const allowed = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor(
        { ...live, database: scratch.name },
        { provisioningAllowed: true },
      ),
    });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.provisioned, false);
  });
});

test("a wrong approved fingerprint halts even when everything else agrees", {
  skip: !ENABLED,
}, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  await withScratchDatabase(connectionString, async (scratch) => {
    await applyMarker(scratch.url, MARKER_VALUE);

    const result = await runPreflight({
      connectionString: scratch.url,
      expected: targetFor({ ...live, database: scratch.name }, {
        clusterFingerprints: Object.freeze([`sha256:${"0".repeat(64)}`]),
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.fingerprintApproved, false);
    assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_FINGERPRINT_MISMATCH"));
  });
});

test("an unreachable database halts without disclosing the credential", {
  skip: !ENABLED,
}, async () => {
  const connectionString = requireConnectionString();
  const live = await describeLiveTarget(connectionString);

  // A port nothing is listening on, with a real-looking credential. The libpq
  // error embeds the DSN, so this asserts the collapse to a single code.
  const unreachable = new URL(connectionString);
  unreachable.port = "65432";

  const result = await runPreflight({
    connectionString: unreachable.toString(),
    expected: targetFor(live),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_OBSERVATION_FAILED"]);
  assert.equal(containsCredential(result), false);
});

function requireConnectionString(): string {
  const connectionString = process.env.DATABASE_URL;
  assert.ok(
    typeof connectionString === "string" && connectionString !== "",
    "DATABASE_URL must point at a disposable PostgreSQL database for this integration test",
  );
  return connectionString;
}

type LiveTarget = Readonly<{
  host: string;
  port: number;
  database: string;
  serverAddress: string;
  serverPort: number;
  fingerprint: string;
}>;

async function describeLiveTarget(connectionString: string): Promise<LiveTarget> {
  const { rows } = await withClient(
    connectionString,
    (client) =>
      client.query(
        "SELECT current_database() AS database_name, " +
          "coalesce(host(inet_server_addr()), '') AS server_address, " +
          "coalesce(inet_server_port()::text, '') AS server_port",
      ),
  );

  const row = rows[0] as
    | Readonly<{ database_name: string; server_address: string | null; server_port: string | null }>
    | undefined;
  assert.ok(row !== undefined, "the live server returned no identity row");

  const { database_name: database, server_address: serverAddress, server_port: serverPortText } = row;
  const serverPort = serverPortText === null ? null : Number(serverPortText);

  assert.ok(database !== "", "the live server reported no database name");
  assert.ok(serverAddress !== null && serverAddress !== "", "the live server exposed no network address");
  assert.ok(serverPort !== null, "the live server exposed no port");

  const url = new URL(connectionString);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port === "" ? 5432 : Number(url.port),
    database,
    serverAddress,
    serverPort,
    fingerprint:
      computeProductionDatabaseFingerprint({
        server: {
          databaseName: database,
          serverAddress,
          serverPort,
          inRecovery: false,
          readOnly: true,
        },
      }) ?? "",
  };
}

/**
 * Builds a reviewed identity for a live target.
 *
 * The fingerprint is always recomputed from `live.database` rather than reusing
 * `live.fingerprint`, because the fingerprint mixes in the database name. That
 * is why a scratch database gets its own fingerprint automatically, and it is
 * also why pointing the reviewed identity at a different database name is caught
 * by the fingerprint check and not only by the name check.
 */
function targetFor(
  live: LiveTarget,
  overrides: Partial<ProductionDatabaseTargetIdentity> = {},
): ProductionDatabaseTargetIdentity {
  const fingerprint =
    overrides.clusterFingerprints ??
    Object.freeze([
      computeProductionDatabaseFingerprint({
        server: {
          databaseName: live.database,
          serverAddress: live.serverAddress,
          serverPort: live.serverPort,
          inRecovery: false,
          readOnly: true,
        },
      }) ?? "",
    ]);

  return Object.freeze({
    id: "primary",
    host: live.host,
    port: live.port,
    database: live.database,
    clusterFingerprints: fingerprint,
    marker: Object.freeze({ rowKey: "primary", value: MARKER_VALUE }),
    provisioningAllowed: false,
    reviewedNote: "Live integration target on a disposable database.",
    ...overrides,
  });
}

type ScratchDatabase = Readonly<{ name: string; url: string }>;

/**
 * Creates a throwaway database on the same live server, runs the body against
 * it, and always drops it. The scratch database therefore shares the cluster
 * address with the reviewed target, which isolates the database-name, marker,
 * and fingerprint dimensions under test.
 *
 * The body connects as the dedicated non-superuser role, so a scenario that
 * passes proves the guard works for an ordinary authenticated credential, not
 * only for the maintenance superuser.
 */
async function withScratchDatabase(
  connectionString: string,
  body: (scratch: ScratchDatabase) => Promise<void>,
): Promise<void> {
  const admin = adminUrl(connectionString);
  await ensureProbeRole(admin.toString());

  const name = `stellarcore_preflight_${randomSuffix()}`;
  // The probe role owns its scratch database so it can create the marker table.
  // PostgreSQL 15+ no longer grants CREATE on `public` to every role, and
  // granting it cluster-wide just to run a test would be an unacceptable
  // privilege change to a shared server.
  await exec(
    admin.toString(),
    `CREATE DATABASE ${quotedIdentifier(name)} OWNER ${quotedIdentifier(PROBE_ROLE)}`,
  );

  const scratch = probeUrl(connectionString, name);

  try {
    await body({ name, url: scratch.toString() });
  } finally {
    await exec(admin.toString(), `DROP DATABASE IF EXISTS ${quotedIdentifier(name)}`);
  }
}

/** Creates the probe role if it is absent, so the run is idempotent. */
async function ensureProbeRole(adminConnectionString: string): Promise<void> {
  const existing = await withClient(adminConnectionString, (client) =>
    client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [PROBE_ROLE]),
  );
  if (existing.rows.length > 0) return;

  await exec(
    adminConnectionString,
    `CREATE ROLE ${quotedIdentifier(PROBE_ROLE)} LOGIN PASSWORD '${PROBE_PASSWORD}'`,
  );
}

function adminUrl(connectionString: string): URL {
  const admin = new URL(connectionString);
  admin.pathname = "/postgres";
  return admin;
}

/** Builds a connection URL for `database` authenticated as the probe role. */
function probeUrl(connectionString: string, database: string): URL {
  const url = new URL(connectionString);
  url.username = PROBE_ROLE;
  url.password = PROBE_PASSWORD;
  url.pathname = `/${database}`;
  return url;
}

async function applyMarker(connectionString: string, marker: string): Promise<void> {
  await exec(
    connectionString,
    "CREATE TABLE public.production_database_identity ("
      + "row_key TEXT PRIMARY KEY, marker TEXT NOT NULL, "
      + "created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  await exec(
    connectionString,
    "INSERT INTO public.production_database_identity (row_key, marker) VALUES ('primary', "
      + `'${marker.replaceAll("'", "''")}')`,
  );
}

async function exec(connectionString: string, sql: string): Promise<void> {
  await withClient(connectionString, (client) => client.query(sql));
}

type QueryResult = Readonly<{ rows: readonly unknown[] }>;

async function withClient(
  connectionString: string,
  body: (client: {
    query: (text: string, values?: readonly unknown[]) => Promise<QueryResult>;
    end: () => Promise<void>;
  }) => Promise<QueryResult>,
): Promise<QueryResult> {
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await body(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function quotedIdentifier(name: string): string {
  assert.match(name, /^[a-z0-9_]+$/, "scratch database names must be plain identifiers");
  return `"${name}"`;
}

function codes(issues: readonly Readonly<{ code: ProductionDatabaseIdentityIssueCode }>[]): string[] {
  return issues.map(({ code }) => code);
}

/**
 * Asserts that no part of the probe credential survives into a reported result.
 *
 * The probe role name and password cannot collide with any reported field
 * (host, port, database name, server address, or a hex digest), so all three
 * credential components can be checked unambiguously here.
 */
function containsCredential(result: unknown): boolean {
  const serialized = JSON.stringify(result);
  if (serialized.includes(PROBE_PASSWORD)) return true;
  if (serialized.includes(PROBE_ROLE)) return true;
  return serialized.includes(`${PROBE_ROLE}:${PROBE_PASSWORD}@`);
}
