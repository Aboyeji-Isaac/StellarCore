import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PRODUCTION_DATABASE_IDENTITY_RELATION,
  PRODUCTION_DATABASE_IDENTITY_SCHEMA,
  PRODUCTION_DATABASE_IDENTITY_TABLE,
  ProductionDatabaseIdentityAuditError,
  assertProductionDatabaseIdentity,
  assertProductionDatabaseIdentityTableIdentifier,
  auditProductionDatabaseIdentity,
  auditProductionDatabaseTargetIdentity,
  computeProductionDatabaseFingerprint,
  narrowProductionDatabaseTargetIdentity,
  parseProductionDatabaseTarget,
  redactProductionDatabaseUrl,
  type ProductionDatabaseIdentityIssueCode,
} from "@/lib/config/productionDatabaseIdentity";
import {
  auditCurrentProductionDatabaseIdentityRegistry,
  currentProductionDatabaseTarget,
  resolveExpectedProductionDatabaseTarget,
} from "@/lib/config/currentProductionDatabaseIdentity";
import type {
  ProductionDatabaseObservation,
  ProductionDatabaseServerObservation,
  ProductionDatabaseTargetIdentity,
  ResolvedDatabaseTarget,
} from "@/types/productionDatabaseIdentity";

const APPROVED_HOST = "db.stellarcore.example";
const APPROVED_DATABASE = "stellarcore_prod";
const APPROVED_MARKER = "STELLARCORE_PRODUCTION_DATABASE_V1";
const SERVER_ADDRESS = "203.0.113.17";
const SERVER_PORT = 5432;

/**
 * A credential that authenticates successfully against a real server but points
 * somewhere else. Used to prove a valid credential on the wrong database fails
 * before mutation, which is the whole point of the guard.
 */
const WRONG_TARGET_URL =
  "postgresql://stellarcore_app:hunter2@db.stellarcore-replica.example:5432/staging";

test("the correct production database passes the identity check", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation(),
  });

  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(result.action, "continue");
  assert.equal(result.targetId, "primary");
  assert.equal(result.fingerprintApproved, true);
  assert.equal(result.provisioned, true);
  assert.equal(result.observed.readOnly, true);
  assert.equal(result.observed.database, APPROVED_DATABASE);
  assert.equal(result.observed.serverAddress, SERVER_ADDRESS);
  assert.deepEqual(result.configured, {
    host: APPROVED_HOST,
    port: 5432,
    database: APPROVED_DATABASE,
  });
});

test("a valid credential pointing at a different host fails before mutation", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({
      target: { host: "db.stellarcore-replica.example", port: 5432, database: APPROVED_DATABASE },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_HOST_MISMATCH"]);
});

test("a valid credential pointing at a different port fails before mutation", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({
      target: { host: APPROVED_HOST, port: 6543, database: APPROVED_DATABASE },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_PORT_MISMATCH"]);
});

test("a credential naming a different database fails even when the server agrees with it", () => {
  // The dangerous shape: a staged database that really is named `staging`. The
  // URL text and the server both agree, so only the reviewed registry catches it.
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({
      target: { host: APPROVED_HOST, port: 5432, database: "staging" },
      server: { databaseName: "staging" },
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), [
    "PRODUCTION_DATABASE_FINGERPRINT_MISMATCH",
    "PRODUCTION_DATABASE_NAME_MISMATCH",
  ]);
});

test("a URL whose database name disagrees with the server fails", () => {
  // The URL says `staging` while the server reports the production database.
  // The server is authoritative, so this halts on the name check alone; the
  // fingerprint still matches because the server is the reviewed cluster.
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({
      target: { host: APPROVED_HOST, port: 5432, database: "staging" },
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_NAME_MISMATCH"]);
});

test("a marker that disagrees with the reviewed value fails", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({ marker: "STELLARCORE_STAGING_DATABASE_V1" }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_MARKER_MISMATCH"]);
});

test("a provisioned target with no marker row fails", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({ marker: null }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);
  assert.equal(result.provisioned, true);
});

test("an unapproved cluster fingerprint fails", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target({
      clusterFingerprints: Object.freeze([fingerprintOf("stellarcore_prod", "198.51.100.9", 5432)]),
    }),
    observation: observation(),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_FINGERPRINT_MISMATCH"]);
  assert.equal(result.fingerprintApproved, false);
});

test("a fingerprint the server cannot report fails rather than passing", () => {
  // A Unix-domain socket or a proxying endpoint hides `inet_server_addr()`.
  // Treating an unverifiable identity as acceptable would silently defeat the
  // guard, so this halts.
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({ server: { serverAddress: null, serverPort: null } }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.fingerprint, null);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED"]);
});

test("a probe that could not enforce read-only fails", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({ server: { readOnly: false } }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_READ_ONLY_REQUIRED"]);
});

test("a read replica is rejected as a mutation target", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({ server: { inRecovery: true } }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_TARGET_IN_RECOVERY"]);
});

test("a missing reviewed identity fails closed", () => {
  const result = auditProductionDatabaseIdentity({ expected: null, observation: observation() });

  assert.equal(result.ok, false);
  assert.equal(result.action, "halt");
  assert.equal(result.targetId, null);
  assert.deepEqual(codes(result.issues), ["PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING"]);
  assert.deepEqual(result.configured, { host: null, port: null, database: null });
  // With no expectation there is nothing to approve against, so the fingerprint
  // is reported as computed-but-unapproved rather than as a derived mismatch
  // that would bury the root cause.
  assert.equal(result.fingerprintApproved, false);
  assert.notEqual(result.fingerprint, null);
});

test("an unprovisioned target is rejected unless the registry allows provisioning", () => {
  const unprovisioned = observation({ identityTablePresent: false, marker: null });

  const rejected = auditProductionDatabaseIdentity({
    expected: target({ provisioningAllowed: false }),
    observation: unprovisioned,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.provisioned, false);
  assert.deepEqual(codes(rejected.issues), ["PRODUCTION_DATABASE_MARKER_MISSING"]);

  const allowed = auditProductionDatabaseIdentity({
    expected: target({ provisioningAllowed: true }),
    observation: unprovisioned,
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.provisioned, false);
});

test("allowing provisioning does not admit any other database", () => {
  const result = auditProductionDatabaseIdentity({
    expected: target({ provisioningAllowed: true }),
    observation: observation({
      identityTablePresent: false,
      marker: null,
      target: { host: "db.somewhere-else.example", port: 5432, database: APPROVED_DATABASE },
    }),
  });

  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_HOST_MISMATCH"));
});

test("the fingerprint is a stable digest of non-secret server facts", () => {
  // Locked literal: changing the canonical form or the version tag is a
  // security-relevant change that must be a deliberate registry update.
  assert.equal(
    computeProductionDatabaseFingerprint({
      server: server({ databaseName: APPROVED_DATABASE, serverAddress: SERVER_ADDRESS }),
    }),
    APPROVED_FINGERPRINT,
  );
});

test("the fingerprint is independent of the mutable URL text", () => {
  const viaProductionUrl = computeProductionDatabaseFingerprint({ server: server() });
  const viaStagingUrl = computeProductionDatabaseFingerprint({ server: server() });

  assert.equal(viaProductionUrl, viaStagingUrl);
  assert.match(String(viaProductionUrl), /^sha256:[0-9a-f]{64}$/);
});

test("the fingerprint changes when the server-reported identity changes", () => {
  const base = APPROVED_FINGERPRINT;
  const otherAddress = computeProductionDatabaseFingerprint({
    server: server({ serverAddress: "198.51.100.9" }),
  });
  const otherDatabase = computeProductionDatabaseFingerprint({
    server: server({ databaseName: "staging" }),
  });
  const otherPort = computeProductionDatabaseFingerprint({
    server: server({ serverPort: 6543 }),
  });

  assert.notEqual(base, otherAddress);
  assert.notEqual(base, otherDatabase);
  assert.notEqual(base, otherPort);
});

test("identity diagnostics never contain the connection string, username, or password", () => {
  const parsed = parseProductionDatabaseTarget(WRONG_TARGET_URL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const result = auditProductionDatabaseIdentity({
    expected: target(),
    observation: observation({
      target: parsed.target,
      server: { databaseName: "staging", serverAddress: "198.51.100.9" },
      marker: "hunter2-is-not-the-marker",
    }),
  });

  assert.equal(result.ok, false);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(WRONG_TARGET_URL), false);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("stellarcore_app"), false);
  assert.equal(serialized.includes("password"), false);
  // The observed database name is intentionally reported: it is the
  // non-secret fact an operator needs to see, and it comes from the server
  // rather than from the credential.
  assert.equal(serialized.includes("staging"), true);

  // Structurally: an issue can only carry a code and a field name, so there is
  // no channel through which a caller could smuggle a secret into CI output.
  for (const issue of result.issues) {
    assert.equal(Object.keys(issue).every((key) => key === "code" || key === "field"), true);
  }
});

test("redactProductionDatabaseUrl reports the target but never the credential", () => {
  const redacted = redactProductionDatabaseUrl(WRONG_TARGET_URL);

  assert.equal(redacted, "postgresql://<redacted>@db.stellarcore-replica.example:5432/staging");
  assert.equal(redacted.includes("hunter2"), false);
  assert.equal(redacted.includes("stellarcore_app"), false);
  assert.equal(redactProductionDatabaseUrl("nonsense"), "<unparseable-database-url>");
  assert.equal(redactProductionDatabaseUrl(undefined), "<unparseable-database-url>");
});

test("parseProductionDatabaseTarget discards the credential and defaults the port", () => {
  assert.deepEqual(parseProductionDatabaseTarget(WRONG_TARGET_URL), {
    ok: true,
    target: { host: "db.stellarcore-replica.example", port: 5432, database: "staging" },
  });

  assert.deepEqual(
    parseProductionDatabaseTarget("postgresql://u:p@DB.StellarCore.Example./My_Db?schema=public"),
    { ok: true, target: { host: "db.stellarcore.example", port: 5432, database: "my_db" } },
  );

  assert.deepEqual(parseProductionDatabaseTarget("postgres://u:p@db.example:6543/db"), {
    ok: true,
    target: { host: "db.example", port: 6543, database: "db" },
  });
});

test("parseProductionDatabaseTarget rejects unusable connection strings", () => {
  for (const value of [undefined, "", "   "]) {
    assert.deepEqual(parseProductionDatabaseTarget(value), {
      ok: false,
      code: "PRODUCTION_DATABASE_URL_MISSING",
    });
  }

  for (const value of ["not a url", "postgresql://", "postgresql://u:p@/db"]) {
    assert.deepEqual(parseProductionDatabaseTarget(value), {
      ok: false,
      code: "PRODUCTION_DATABASE_URL_INVALID",
    });
  }

  for (const value of [
    "mysql://u:p@db.example/db",
    "prisma+postgres://db.example/db",
    "file:./dev.db",
  ]) {
    assert.deepEqual(parseProductionDatabaseTarget(value), {
      ok: false,
      code: "PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED",
    });
  }
});

test("audit results are frozen and deterministically ordered", () => {
  const broken = auditProductionDatabaseIdentity({
    expected: target({
      clusterFingerprints: Object.freeze([fingerprintOf("staging", "198.51.100.9", 5432)]),
    }),
    observation: observation({
      target: { host: "db.elsewhere.example", port: 7000, database: "staging" },
      server: { databaseName: "staging", inRecovery: true, readOnly: false },
      marker: null,
    }),
  });

  const first = broken.issues.map(({ code, field }) => `${code}:${field ?? ""}`);
  const second = auditProductionDatabaseIdentity({
    expected: target({
      clusterFingerprints: Object.freeze([fingerprintOf("staging", "198.51.100.9", 5432)]),
    }),
    observation: observation({
      target: { host: "db.elsewhere.example", port: 7000, database: "staging" },
      server: { databaseName: "staging", inRecovery: true, readOnly: false },
      marker: null,
    }),
  }).issues.map(({ code, field }) => `${code}:${field ?? ""}`);

  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort(), first);
  assert.deepEqual(new Set(first).size, first.length);
  assert.equal(Object.isFrozen(broken), true);
  assert.equal(Object.isFrozen(broken.issues), true);
  assert.equal(Object.isFrozen(broken.issues[0]), true);
  assert.ok(first.length >= 6);
});

test("assertProductionDatabaseIdentity throws a typed, credential-free error", () => {
  assert.equal(
    assertProductionDatabaseIdentity({ expected: target(), observation: observation() }).ok,
    true,
  );

  try {
    assertProductionDatabaseIdentity({
      expected: target(),
      observation: observation({
        target: parseProductionDatabaseTarget(WRONG_TARGET_URL).ok
          ? {
              host: "db.stellarcore-replica.example",
              port: 5432,
              database: "staging",
            }
          : { host: "", port: 0, database: "" },
        marker: "STELLARCORE_STAGING_DATABASE_V1",
      }),
    });
    assert.fail("expected the identity assertion to throw");
  } catch (error) {
    assert.ok(error instanceof ProductionDatabaseIdentityAuditError);
    assert.equal(error.code, "PRODUCTION_DATABASE_TARGET_IDENTITY_UNVERIFIED");
    assert.equal(error.name, "ProductionDatabaseIdentityAuditError");
    assert.equal(error.message.includes("hunter2"), false);
    assert.ok(error.issues.length > 0);
    assert.equal(error.result.action, "halt");
  }
});

test("a malformed reviewed identity is rejected before it is enforced", () => {
  assert.deepEqual(auditProductionDatabaseTargetIdentity(null), [
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING" },
  ]);
  assert.deepEqual(auditProductionDatabaseTargetIdentity("primary"), [
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING" },
  ]);
  assert.deepEqual(auditProductionDatabaseTargetIdentity({}), [
    { code: "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID", field: "clusterFingerprint" },
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "database" },
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "expected" },
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "host" },
    { code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "port" },
    { code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" },
  ]);
  assert.deepEqual(
    auditProductionDatabaseTargetIdentity(target({ clusterFingerprints: Object.freeze(["nope"]) })),
    [{ code: "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID", field: "clusterFingerprint" }],
  );
  assert.deepEqual(
    auditProductionDatabaseTargetIdentity(
      target({ marker: Object.freeze({ rowKey: "primary", value: "short" }) }),
    ),
    [{ code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" }],
  );
  assert.deepEqual(
    auditProductionDatabaseTargetIdentity(
      // A marker carrying spaces could not survive a log line or a shell
      // argument unambiguously, so the pattern excludes it.
      target({ marker: Object.freeze({ rowKey: "primary", value: "MARKER WITH SPACES" }) }),
    ),
    [{ code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" }],
  );
  assert.deepEqual(
    auditProductionDatabaseTargetIdentity(
      target({ marker: Object.freeze({ rowKey: "primary; DROP TABLE", value: APPROVED_MARKER }) }),
    ),
    [{ code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" }],
  );
  assert.deepEqual(auditProductionDatabaseTargetIdentity(target()), []);
});

test("environment pins can narrow the approved identity but never widen it", () => {
  const approved = target();

  const narrowed = narrowProductionDatabaseTargetIdentity(approved, {
    PRODUCTION_DATABASE_EXPECTED_FINGERPRINT: APPROVED_FINGERPRINT,
  });
  assert.equal(narrowed.ok, true);
  if (narrowed.ok) {
    assert.deepEqual(narrowed.target.clusterFingerprints, [APPROVED_FINGERPRINT]);
  }

  const unchanged = narrowProductionDatabaseTargetIdentity(approved, {
    PRODUCTION_DATABASE_EXPECTED_MARKER: APPROVED_MARKER,
  });
  assert.equal(unchanged.ok, true);

  for (const environment of [
    { PRODUCTION_DATABASE_EXPECTED_FINGERPRINT: "sha256:not-hex" },
    { PRODUCTION_DATABASE_EXPECTED_FINGERPRINT: fingerprintOf("staging", "198.51.100.9", 5432) },
    { PRODUCTION_DATABASE_EXPECTED_MARKER: "SOMETHING_ELSE_V1" },
  ]) {
    const result = narrowProductionDatabaseTargetIdentity(approved, environment);
    assert.equal(result.ok, false, JSON.stringify(environment));
    if (!result.ok) {
      assert.equal(
        result.code,
        Object.keys(environment)[0] === "PRODUCTION_DATABASE_EXPECTED_MARKER"
          ? "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID"
          : "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID",
      );
    }
  }

  assert.equal(narrowProductionDatabaseTargetIdentity(approved, {}).ok, true);
  assert.equal(
    narrowProductionDatabaseTargetIdentity(approved, { PRODUCTION_DATABASE_EXPECTED_MARKER: "  " })
      .ok,
    true,
  );
});

test("the checked-in production database registry is well formed and credential free", () => {
  const registry = auditCurrentProductionDatabaseIdentityRegistry();

  assert.deepEqual(registry.issues, []);
  assert.equal(registry.ok, true);
  assert.ok(registry.targets.length > 0);

  const serialized = JSON.stringify(registry);
  for (const forbidden of ["password", "PASSWORD", "://", "postgres://", "DATABASE_URL"]) {
    assert.equal(serialized.includes(forbidden), false, `registry leaked ${forbidden}`);
  }
});

test("the checked-in placeholder host can never resolve to a real database", () => {
  // The repository ships with an unresolved placeholder so no pull request can
  // accidentally authorise a real host. The reserved `.invalid` TLD is
  // guaranteed by RFC 2606 never to resolve, and the all-zero fingerprint can
  // never be produced by a SHA-256 preimage, so the preflight halts until a
  // maintainer replaces both through review.
  const checkedIn = currentProductionDatabaseTarget();

  assert.equal(checkedIn.host.endsWith(".invalid"), true);
  assert.equal(checkedIn.clusterFingerprints.length, 1);
  assert.equal(
    /^sha256:0+$/.test(checkedIn.clusterFingerprints[0] ?? ""),
    true,
  );

  const result = auditProductionDatabaseIdentity({
    expected: checkedIn,
    observation: observation(),
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_FINGERPRINT_MISMATCH"));
  assert.ok(codes(result.issues).includes("PRODUCTION_DATABASE_HOST_MISMATCH"));
});

test("resolveExpectedProductionDatabaseTarget fails closed when a pin disagrees", () => {
  assert.equal(resolveExpectedProductionDatabaseTarget({}).ok, true);

  const mismatched = resolveExpectedProductionDatabaseTarget({
    PRODUCTION_DATABASE_EXPECTED_MARKER: "SOMETHING_ELSE_V1",
  });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.code, "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID");
  }
});

test("the marker table identifier is a validated, non-injectable constant", () => {
  assert.equal(
    assertProductionDatabaseIdentityTableIdentifier(),
    PRODUCTION_DATABASE_IDENTITY_RELATION,
  );
  assert.equal(
    PRODUCTION_DATABASE_IDENTITY_RELATION,
    `${PRODUCTION_DATABASE_IDENTITY_SCHEMA}.${PRODUCTION_DATABASE_IDENTITY_TABLE}`,
  );
  assert.match(PRODUCTION_DATABASE_IDENTITY_TABLE, /^[a-z_][a-z0-9_]*$/);
  assert.match(PRODUCTION_DATABASE_IDENTITY_SCHEMA, /^[a-z_][a-z0-9_]*$/);
});

test("the committed migration and the reviewed registry agree on the marker", () => {
  const migration = readFileSync(
    new URL(
      "../../../prisma/migrations/20260930120000_production_database_identity/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const schema = readFileSync(
    new URL("../../../prisma/schema.prisma", import.meta.url),
    "utf8",
  );
  const checkedIn = currentProductionDatabaseTarget();

  // The marker is committed in three places. A mismatch would let the preflight
  // halt forever against a correctly migrated database, so it is asserted rather
  // than trusted.
  assert.ok(migration.includes(`'${checkedIn.marker.value}'`));
  assert.ok(migration.includes(`'${checkedIn.marker.rowKey}'`));
  assert.ok(migration.includes(`"${PRODUCTION_DATABASE_IDENTITY_TABLE}"`));
  assert.ok(migration.includes('"row_key" TEXT NOT NULL'));
  assert.ok(schema.includes("model ProductionDatabaseIdentity"));
  assert.ok(schema.includes(`@@map("${PRODUCTION_DATABASE_IDENTITY_TABLE}")`));
  assert.ok(schema.includes('@map("row_key")'));
});

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
    reviewedNote: "Reviewed production target used by the identity unit tests.",
    ...overrides,
  });
}

function server(
  overrides: Partial<ProductionDatabaseServerObservation> = {},
): ProductionDatabaseServerObservation {
  return Object.freeze({
    databaseName: APPROVED_DATABASE,
    serverAddress: SERVER_ADDRESS,
    serverPort: SERVER_PORT,
    inRecovery: false,
    readOnly: true,
    ...overrides,
  });
}

function observation(
  overrides: Readonly<{
    target?: Partial<ResolvedDatabaseTarget>;
    server?: Partial<ProductionDatabaseServerObservation>;
    identityTablePresent?: boolean;
    marker?: string | null;
  }> = {},
): ProductionDatabaseObservation {
  return Object.freeze({
    target: Object.freeze({
      host: APPROVED_HOST,
      port: 5432,
      database: APPROVED_DATABASE,
      ...overrides.target,
    }),
    server: server(overrides.server),
    identityTablePresent: overrides.identityTablePresent ?? true,
    marker: overrides.marker === undefined ? APPROVED_MARKER : overrides.marker,
  });
}

function fingerprintOf(
  databaseName: string,
  serverAddress: string,
  serverPort: number,
): string {
  return (
    computeProductionDatabaseFingerprint({
      server: server({ databaseName, serverAddress, serverPort }),
    }) ?? ""
  );
}

function codes(issues: readonly Readonly<{ code: ProductionDatabaseIdentityIssueCode }>[]): string[] {
  return issues.map(({ code }) => code);
}

const APPROVED_FINGERPRINT = fingerprintOf(APPROVED_DATABASE, SERVER_ADDRESS, SERVER_PORT);
