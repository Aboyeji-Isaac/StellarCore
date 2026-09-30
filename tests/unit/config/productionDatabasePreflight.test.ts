import assert from "node:assert/strict";
import test from "node:test";

import {
  computeProductionDatabaseFingerprint,
  type ProductionDatabaseIdentityIssueCode,
} from "@/lib/config/productionDatabaseIdentity";
import {
  createObserver,
  runPreflight,
  type ProductionDatabaseQueryClient,
} from "@/lib/config/productionDatabasePreflight";
import type {
  ProductionDatabaseServerObservation,
  ProductionDatabaseTargetIdentity,
} from "@/types/productionDatabaseIdentity";

const APPROVED_HOST = "db.stellarcore.example";
const APPROVED_DATABASE = "stellarcore_prod";
const APPROVED_MARKER = "STELLARCORE_PRODUCTION_DATABASE_V1";
const SERVER_ADDRESS = "203.0.113.17";
const SERVER_PORT = 5432;

/** A syntactically valid credential that authenticates against a real server. */
const VALID_CREDENTIAL_URL =
  "postgresql://stellarcore_app:hunter2@db.stellarcore.example:5432/stellarcore_prod";

/**
 * The same working credential pointed at a different database. The connection
 * succeeds, so only the identity check can stop a mutation — which is the
 * failure this guard exists to prevent.
 */
const WRONG_TARGET_URL =
  "postgresql://stellarcore_app:hunter2@db.stellarcore.example:5432/staging";

const MUTATING_SQL = /\b(insert|update|delete|create|drop|alter|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh|comment)\b/i;

type RecordedStatement = Readonly<{ text: string; values?: readonly unknown[] }>;

test("the correct production database continues through the preflight", async () => {
  const probe = recordingProbe();
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.action, "continue");
  assert.equal(result.targetId, "primary");
  assert.equal(result.fingerprintApproved, true);
  assert.equal(result.provisioned, true);
  assert.equal(result.fingerprint, APPROVED_FINGERPRINT);
  assert.equal(result.observed.readOnly, true);
  assert.equal(result.observed.serverAddress, SERVER_ADDRESS);
  assert.equal(probe.ended(), true);
});

test("a valid credential pointing at a different database halts before mutation", async () => {
  const probe = recordingProbe({
    server: {
      database_name: "staging",
      transaction_read_only: "on",
      server_address: "198.51.100.9",
      server_port: "5432",
      in_recovery: false,
    },
    marker: [{ marker: "STELLARCORE_STAGING_DATABASE_V1" }],
  });

  const result = await runPreflight({
    connectionString: WRONG_TARGET_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_NAME_MISMATCH"));
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_FINGERPRINT_MISMATCH"));
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_MARKER_MISMATCH"));

  // The observed database name is reported on purpose — it is the server's own
  // answer and is what an operator needs. The credential never appears.
  assert.equal(result.observed.database, "staging");
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes("stellarcore_app"), false);
  assert.equal(JSON.stringify(result).includes(WRONG_TARGET_URL), false);
});

test("the probe runs inside an explicitly read-only transaction and never mutates", async () => {
  const probe = recordingProbe();
  await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  const statements = probe.statements();
  assert.equal(statements[0]?.text, "BEGIN TRANSACTION READ ONLY");
  assert.equal(statements[statements.length - 1]?.text, "COMMIT");

  for (const statement of statements) {
    assert.equal(MUTATING_SQL.test(statement.text), false, `mutating SQL: ${statement.text}`);
  }

  // Every data read is a plain SELECT against a session function or the marker
  // row; nothing depends on a schema object existing beyond the marker relation.
  assert.match(statements[1]?.text ?? "", /^SELECT current_database\(\)/);
  assert.match(statements[1]?.text ?? "", /pg_is_in_recovery\(\)/);
});

test("the marker row key is bound as a parameter and never interpolated", async () => {
  const probe = recordingProbe();
  await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  const markerRead = probe
    .statements()
    .find((statement) => statement.text.includes("FROM public.production_database_identity"));
  assert.ok(markerRead);
  assert.match(markerRead.text, /WHERE row_key = \$1/);
  assert.deepEqual(markerRead.values, ["primary"]);
  assert.equal(markerRead.text.includes("primary"), false);
});

test("an unprovisioned approved database halts unless provisioning is reviewed", async () => {
  const unprovisioned = recordingProbe({ present: [{ present: false }] });

  const rejected = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target({ provisioningAllowed: false }),
    createClient: () => Promise.resolve(unprovisioned.client),
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.provisioned, false);
  assert.deepEqual(codes(rejected.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);

  const allowed = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target({ provisioningAllowed: true }),
    createClient: () => Promise.resolve(unprovisioned.client),
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.provisioned, false);
});

test("a driver error carrying the connection string collapses to a credential-free halt", async () => {
  const client: ProductionDatabaseQueryClient = {
    connect: () => Promise.reject(new Error(`connection to ${VALID_CREDENTIAL_URL} refused`)),
    query: () => Promise.reject(new Error("unreachable")),
    end: () => Promise.resolve(),
  };

  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(client),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_OBSERVATION_FAILED"]);
  assert.equal(JSON.stringify(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes(VALID_CREDENTIAL_URL), false);
  assert.equal(JSON.stringify(result).includes("refused"), false);
});

test("a connection failure never reaches the audit", async () => {
  let constructed = false;
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => {
      constructed = true;
      return Promise.reject(new Error("ECONNREFUSED"));
    },
  });

  assert.equal(constructed, true);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_OBSERVATION_FAILED"]);
});

test("the probe always closes the connection, including on failure", async () => {
  const failing = recordingProbe({
    failOn: "SELECT current_database()",
  });
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(failing.client),
  });

  assert.equal(result.ok, false);
  assert.equal(failing.ended(), true);
  assert.ok(
    failing.statements().some((statement) => statement.text === "ROLLBACK"),
    "an aborted probe must roll back its read-only transaction",
  );
});

test("a client that never connects is not closed, which would mask the failure", async () => {
  // `pg` throws if `end()` is called on a client that never connected, so the
  // probe tracks the connection and skips the close in that case.
  let ended = false;
  const client: ProductionDatabaseQueryClient = {
    connect: () => Promise.reject(new Error("ECONNREFUSED")),
    query: () => Promise.reject(new Error("unreachable")),
    end: () => {
      ended = true;
      return Promise.resolve();
    },
  };

  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(client),
  });

  assert.equal(result.ok, false);
  assert.equal(ended, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_OBSERVATION_FAILED"]);
});

test("an unusable connection string halts before any connection is opened", async () => {
  let constructed = false;
  const result = await runPreflight({
    connectionString: "mysql://u:p@db.example/stellarcore_prod",
    expected: target(),
    createClient: () => {
      constructed = true;
      return Promise.reject(new Error("should not be called"));
    },
  });

  assert.equal(constructed, false);
  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED"]);
});

test("a missing connection string halts", async () => {
  const result = await runPreflight({
    connectionString: undefined,
    environment: {},
    expected: target(),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_URL_MISSING"]);
});

test("a missing reviewed identity halts without connecting", async () => {
  let constructed = false;
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: null,
    createClient: () => {
      constructed = true;
      return Promise.reject(new Error("should not be called"));
    },
  });

  assert.equal(constructed, false);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING"]);
});

test("a probe that could not enforce read-only halts", async () => {
  const probe = recordingProbe({
    server: { ...SERVER_ROW, transaction_read_only: "off" },
  });
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_READ_ONLY_REQUIRED"]);
  assert.equal(result.observed.readOnly, false);
});

test("a read replica is rejected as a mutation target", async () => {
  const probe = recordingProbe({ server: { ...SERVER_ROW, in_recovery: true } });
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_TARGET_IN_RECOVERY"]);
  assert.equal(result.observed.inRecovery, true);
});

test("a Unix-domain socket connection is unverifiable and halts", async () => {
  const probe = recordingProbe({
    server: { ...SERVER_ROW, server_address: "", server_port: "" },
  });
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.equal(result.ok, false);
  assert.equal(result.fingerprint, null);
  assert.equal(result.observed.serverAddress, null);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED"]);
});

test("a provisioned database with no marker row halts", async () => {
  const probe = recordingProbe({ marker: [] });
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    createClient: () => Promise.resolve(probe.client),
  });

  assert.equal(result.ok, false);
  assert.equal(result.provisioned, true);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);
});

test("the approved row key is what the probe is asked to read", async () => {
  const seen: string[] = [];
  const result = await runPreflight({
    connectionString: VALID_CREDENTIAL_URL,
    expected: target(),
    observe: (connectionString, options) => {
      seen.push(connectionString);
      assert.equal(options.markerRowKey, "primary");
      return Promise.resolve({ ok: false });
    },
  });

  assert.deepEqual(seen, [VALID_CREDENTIAL_URL]);
  assert.equal(result.ok, false);
});

test("a preflight result never claims continue while carrying an issue", async () => {
  // Each scenario should continue: the approved target, and the approved target
  // while it is still being provisioned. The invariant under test is that
  // `continue` and "no issues" are never out of step in either direction.
  const scenarios: readonly Readonly<{
    probe: ReturnType<typeof recordingProbe>;
    expected: ProductionDatabaseTargetIdentity;
  }>[] = [
    { probe: recordingProbe(), expected: target() },
    {
      probe: recordingProbe({ present: [{ present: false }] }),
      expected: target({ provisioningAllowed: true }),
    },
  ];

  for (const scenario of scenarios) {
    const result = await runPreflight({
      connectionString: VALID_CREDENTIAL_URL,
      expected: scenario.expected,
      createClient: () => Promise.resolve(scenario.probe.client),
    });

    assert.equal(result.action, "continue", JSON.stringify(result.issues));
    assert.equal(result.issues.length, 0);
    assert.equal(result.ok, true);
  }
});

test("a preflight result never claims continue while failing a check", async () => {
  // The converse invariant: every failing scenario halts, and none of them can
  // slip through as `continue` with an issue attached.
  const scenarios: readonly Readonly<{
    probe: ReturnType<typeof recordingProbe>;
    expected: ProductionDatabaseTargetIdentity;
    reason: string;
  }>[] = [
    {
      probe: recordingProbe({ present: [{ present: false }] }),
      expected: target(),
      reason: "an unprovisioned target that was not reviewed for provisioning",
    },
    {
      probe: recordingProbe({ server: { ...SERVER_ROW, in_recovery: true } }),
      expected: target(),
      reason: "a read replica",
    },
    {
      probe: recordingProbe({ server: { ...SERVER_ROW, transaction_read_only: "off" } }),
      expected: target(),
      reason: "a probe that was not read-only",
    },
    {
      probe: recordingProbe({ server: { ...SERVER_ROW, database_name: "staging" } }),
      expected: target(),
      reason: "a different live database",
    },
    { probe: recordingProbe({ marker: [] }), expected: target(), reason: "a missing marker row" },
    {
      probe: recordingProbe({ marker: [{ marker: "OTHER" }] }),
      expected: target(),
      reason: "a wrong marker",
    },
  ];

  for (const scenario of scenarios) {
    const result = await runPreflight({
      connectionString: VALID_CREDENTIAL_URL,
      expected: scenario.expected,
      createClient: () => Promise.resolve(scenario.probe.client),
    });

    assert.equal(result.ok, false, scenario.reason);
    assert.equal(result.action, "halt", scenario.reason);
    assert.ok(result.issues.length > 0, scenario.reason);
  }
});

test("the exported observer is reusable with an explicit client factory", async () => {
  const probe = recordingProbe();
  const observe = createObserver(() => Promise.resolve(probe.client));
  const result = await observe(VALID_CREDENTIAL_URL, { markerRowKey: "primary" });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.probe.server, {
    databaseName: APPROVED_DATABASE,
    serverAddress: SERVER_ADDRESS,
    serverPort: SERVER_PORT,
    inRecovery: false,
    readOnly: true,
  });
  assert.equal(result.probe.identityTablePresent, true);
  assert.equal(result.probe.marker, APPROVED_MARKER);
});

const SERVER_ROW = Object.freeze({
  database_name: APPROVED_DATABASE,
  transaction_read_only: "on",
  server_address: SERVER_ADDRESS,
  server_port: String(SERVER_PORT),
  in_recovery: false,
});

function recordingProbe(
  options: Readonly<{
    server?: Record<string, unknown>;
    present?: readonly unknown[];
    marker?: readonly unknown[];
    failOn?: string;
  }> = {},
) {
  const statements: RecordedStatement[] = [];
  let closed = false;

  let connected = false;

  const client: ProductionDatabaseQueryClient = {
    connect: () => {
      connected = true;
      return Promise.resolve();
    },
    query: (text, values) => {
      assert.equal(connected, true, "the probe must connect before querying");
      statements.push(Object.freeze({ text, ...(values === undefined ? {} : { values }) }));

      if (options.failOn !== undefined && text.includes(options.failOn)) {
        return Promise.reject(new Error("statement failed"));
      }
      if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
        return Promise.resolve({ rows: [] });
      }
      if (text.includes("to_regclass")) {
        return Promise.resolve({ rows: options.present ?? [{ present: true }] });
      }
      if (text.includes("current_database()")) {
        return Promise.resolve({ rows: [options.server ?? SERVER_ROW] });
      }
      if (text.includes("FROM public.production_database_identity")) {
        return Promise.resolve({ rows: options.marker ?? [{ marker: APPROVED_MARKER }] });
      }
      return Promise.resolve({ rows: [] });
    },
    end: () => {
      closed = true;
      return Promise.resolve();
    },
  };

  return {
    client,
    statements: () => statements,
    ended: () => closed,
  };
}

function target(
  overrides: Partial<ProductionDatabaseTargetIdentity> = {},
): ProductionDatabaseTargetIdentity {
  return Object.freeze({
    id: "primary",
    host: APPROVED_HOST,
    port: 5432,
    database: APPROVED_DATABASE,
    clusterFingerprints: Object.freeze([APPROVED_FINGERPRINT]),
    marker: Object.freeze({ rowKey: "primary", value: APPROVED_MARKER }),
    provisioningAllowed: false,
    reviewedNote: "Reviewed production target used by the preflight unit tests.",
    ...overrides,
  });
}

function codes(issues: readonly Readonly<{ code: ProductionDatabaseIdentityIssueCode }>[]): string[] {
  return issues.map(({ code }) => code);
}

const APPROVED_FINGERPRINT =
  computeProductionDatabaseFingerprint({
    server: Object.freeze({
      databaseName: APPROVED_DATABASE,
      serverAddress: SERVER_ADDRESS,
      serverPort: SERVER_PORT,
      inRecovery: false,
      readOnly: true,
    } satisfies ProductionDatabaseServerObservation),
  }) ?? "";
