import { createHash } from "node:crypto";

import type {
  ProductionDatabaseObservation,
  ProductionDatabaseTargetIdentity,
  ResolvedDatabaseTarget,
} from "@/types/productionDatabaseIdentity";

/**
 * Pure production database target-identity verification.
 *
 * Privileged production workflows (migrations, registry bootstrap) must prove
 * that the credential they were handed points at the reviewed database before
 * they mutate anything. This module owns the entire decision and deliberately
 * performs no I/O, so it is exhaustively unit-testable and cannot leak a
 * secret by accident: every value it reports is either a compile-time enum, a
 * strict-pattern token, or a SHA-256 digest of non-secret server facts.
 *
 * Three independent facts must agree, and the expected values come from the
 * reviewed registry rather than from the connection string:
 *
 * 1. The connection URL's host, port, and database name match the reviewed
 *    target. This is the cheap check and is not trusted on its own.
 * 2. The server's own reported identity (`current_database()` and
 *    `inet_server_addr()`/`inet_server_port()`) hashes to a fingerprint that is
 *    on the reviewed approved list. This is what defeats a mutable URL: a
 *    credential is a means of authentication, not proof of destination.
 * 3. Once the target is provisioned, the non-secret marker row written by a
 *    committed migration matches the reviewed marker.
 *
 * Every failure is a halt. There is no override flag and no "warn and
 * continue" path; only a reviewed registry update can change the outcome.
 */

export const PRODUCTION_DATABASE_FINGERPRINT_SCHEME = "sha256";

/** Version tag mixed into the fingerprint so it can be evolved safely. */
export const PRODUCTION_DATABASE_FINGERPRINT_VERSION = "stellarcore-production-database/v1";

/** Schema holding the marker table. */
export const PRODUCTION_DATABASE_IDENTITY_SCHEMA = "public";

/** Physical table holding the singleton non-secret marker row. */
export const PRODUCTION_DATABASE_IDENTITY_TABLE = "production_database_identity";

/** Schema-qualified table name used for the existence probe and the read. */
export const PRODUCTION_DATABASE_IDENTITY_RELATION = `${PRODUCTION_DATABASE_IDENTITY_SCHEMA}.${PRODUCTION_DATABASE_IDENTITY_TABLE}`;

export const PRODUCTION_DATABASE_DEFAULT_PORT = 5432;

export type ProductionDatabaseIdentityIssueCode =
  | "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID"
  | "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING"
  | "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID"
  | "PRODUCTION_DATABASE_FINGERPRINT_MISMATCH"
  | "PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED"
  | "PRODUCTION_DATABASE_HOST_MISMATCH"
  | "PRODUCTION_DATABASE_MARKER_MISMATCH"
  | "PRODUCTION_DATABASE_MARKER_MISSING"
  | "PRODUCTION_DATABASE_NAME_MISMATCH"
  | "PRODUCTION_DATABASE_OBSERVATION_FAILED"
  | "PRODUCTION_DATABASE_PORT_MISMATCH"
  | "PRODUCTION_DATABASE_READ_ONLY_REQUIRED"
  | "PRODUCTION_DATABASE_TARGET_IN_RECOVERY"
  | "PRODUCTION_DATABASE_URL_INVALID"
  | "PRODUCTION_DATABASE_URL_MISSING"
  | "PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED";

/**
 * A diagnostic carries a code and an optional field name and nothing else.
 * Because there is no free-text payload, no caller can smuggle a connection
 * string, password, or marker value into CI output through this type.
 */
export type ProductionDatabaseIdentityIssue = Readonly<{
  code: ProductionDatabaseIdentityIssueCode;
  field?:
    | "clusterFingerprint"
    | "database"
    | "expected"
    | "host"
    | "marker"
    | "observation"
    | "port"
    | "readOnly"
    | "server";
}>;

export type ProductionDatabaseTargetParseFailureCode =
  | "PRODUCTION_DATABASE_URL_INVALID"
  | "PRODUCTION_DATABASE_URL_MISSING"
  | "PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED";

export type ProductionDatabaseTargetParseResult =
  | Readonly<{ ok: true; target: ResolvedDatabaseTarget }>
  | Readonly<{ ok: false; code: ProductionDatabaseTargetParseFailureCode }>;

export type ProductionDatabaseTargetNarrowResult =
  | Readonly<{ ok: true; target: ProductionDatabaseTargetIdentity }>
  | Readonly<{ ok: false; code: ProductionDatabaseIdentityIssueCode }>;

export type ProductionDatabaseIdentityAuditInput = Readonly<{
  /** The reviewed expectation, or `null` when none is configured. */
  expected: ProductionDatabaseTargetIdentity | null;
  /** What the read-only probe actually saw. */
  observation: ProductionDatabaseObservation;
}>;

export type ProductionDatabaseIdentityAuditResult = Readonly<{
  ok: boolean;
  /** `continue` only when every check passed. */
  action: "continue" | "halt";
  targetId: string | null;
  /** Credential-free description of what the URL claimed. */
  configured: Readonly<{
    host: string | null;
    port: number | null;
    database: string | null;
  }>;
  /** Credential-free description of what the server reported. */
  observed: Readonly<{
    database: string | null;
    serverAddress: string | null;
    serverPort: number | null;
    inRecovery: boolean | null;
    readOnly: boolean | null;
  }>;
  /** `sha256:<hex>` digest, or `null` when it could not be computed. */
  fingerprint: string | null;
  fingerprintApproved: boolean;
  /** `true` when the marker table exists and therefore is enforced. */
  provisioned: boolean;
  issues: readonly ProductionDatabaseIdentityIssue[];
}>;

export class ProductionDatabaseIdentityAuditError extends Error {
  readonly code = "PRODUCTION_DATABASE_TARGET_IDENTITY_UNVERIFIED";
  readonly issues: readonly ProductionDatabaseIdentityIssue[];
  readonly result: ProductionDatabaseIdentityAuditResult;

  constructor(result: ProductionDatabaseIdentityAuditResult) {
    super("Production database target identity verification failed");
    this.name = "ProductionDatabaseIdentityAuditError";
    this.issues = result.issues;
    this.result = result;
  }
}

const SAFE_TOKEN = /^[A-Za-z0-9._:/@+-]{1,255}$/;
const SAFE_HOST = /^[a-z0-9.-]{1,253}$/;
const SAFE_DATABASE = /^[a-z0-9_$-]{1,63}$/;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/;
const SAFE_ROW_KEY = /^[a-z0-9-]{1,64}$/;
const SAFE_MARKER = /^[A-Za-z0-9._:-]{8,200}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const SUPPORTED_PROTOCOLS: readonly string[] = ["postgres:", "postgresql:"];

/**
 * Parses a PostgreSQL connection URL into a credential-free target.
 *
 * The password, and any query parameters or fragments, are dropped here and
 * are never represented in the result, so nothing downstream can print them.
 */
export function parseProductionDatabaseTarget(
  connectionString: string | undefined,
): ProductionDatabaseTargetParseResult {
  if (typeof connectionString !== "string" || connectionString.trim() === "") {
    return Object.freeze({ ok: false, code: "PRODUCTION_DATABASE_URL_MISSING" });
  }

  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return Object.freeze({ ok: false, code: "PRODUCTION_DATABASE_URL_INVALID" });
  }

  if (!SUPPORTED_PROTOCOLS.includes(url.protocol)) {
    return Object.freeze({
      ok: false,
      code: "PRODUCTION_DATABASE_URL_SCHEME_UNSUPPORTED",
    });
  }

  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") {
    return Object.freeze({ ok: false, code: "PRODUCTION_DATABASE_URL_INVALID" });
  }

  const database = safeDecode(url.pathname.replace(/^\/+/, "")).toLowerCase();
  if (database === "") {
    return Object.freeze({ ok: false, code: "PRODUCTION_DATABASE_URL_INVALID" });
  }

  const port = url.port === "" ? PRODUCTION_DATABASE_DEFAULT_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Object.freeze({ ok: false, code: "PRODUCTION_DATABASE_URL_INVALID" });
  }

  return Object.freeze({
    ok: true,
    target: Object.freeze({ host, port, database }),
  });
}

/**
 * Replaces a connection string with a credential-free description suitable for
 * a log line. The username is dropped as well as the password: managed
 * PostgreSQL usernames are frequently random strings that are part of the
 * secret, and omitting them costs nothing diagnostically.
 */
export function redactProductionDatabaseUrl(connectionString: string | undefined): string {
  const parsed = parseProductionDatabaseTarget(connectionString);
  if (!parsed.ok) return "<unparseable-database-url>";
  const { host, port, database } = parsed.target;
  return `postgresql://<redacted>@${host}:${port}/${database}`;
}

/**
 * Hashes the server-reported identity into the approved fingerprint.
 *
 * Only non-secret, server-reported facts are mixed in, so the fingerprint can
 * be reviewed and committed without disclosing anything. `null` means the
 * server did not expose a verifiable address, which the audit treats as a
 * halt rather than as a pass.
 */
export function computeProductionDatabaseFingerprint(
  observation: Pick<ProductionDatabaseObservation, "server">,
): string | null {
  const { databaseName, serverAddress, serverPort } = observation.server;
  if (serverAddress === null || serverPort === null) return null;
  if (!SAFE_TOKEN.test(databaseName) || !SAFE_TOKEN.test(serverAddress)) return null;

  const canonical = [
    PRODUCTION_DATABASE_FINGERPRINT_VERSION,
    `database=${databaseName.toLowerCase()}`,
    `server=${serverAddress.toLowerCase()}/${serverPort}`,
  ].join("\n");

  return `${PRODUCTION_DATABASE_FINGERPRINT_SCHEME}:${createHash("sha256")
    .update(canonical, "utf8")
    .digest("hex")}`;
}

/** Verifies the reviewed expectation is complete and free of unsafe values. */
export function auditProductionDatabaseTargetIdentity(
  expected: unknown,
): readonly ProductionDatabaseIdentityIssue[] {
  const issues: ProductionDatabaseIdentityIssue[] = [];

  if (typeof expected !== "object" || expected === null) {
    return Object.freeze([{ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING" }]);
  }

  const target = expected as Partial<ProductionDatabaseTargetIdentity>;

  if (typeof target.host !== "string" || !SAFE_HOST.test(target.host)) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "host" });
  }
  if (typeof target.port !== "number" || !isValidPort(target.port)) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "port" });
  }
  if (typeof target.database !== "string" || !SAFE_DATABASE.test(target.database)) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "database" });
  }
  if (
    !Array.isArray(target.clusterFingerprints) ||
    target.clusterFingerprints.length === 0 ||
    !target.clusterFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && FINGERPRINT.test(fingerprint),
    )
  ) {
    issues.push({
      code: "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID",
      field: "clusterFingerprint",
    });
  }
  if (typeof target.marker !== "object" || target.marker === null) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" });
  } else if (
    typeof target.marker.rowKey !== "string" ||
    !SAFE_ROW_KEY.test(target.marker.rowKey) ||
    typeof target.marker.value !== "string" ||
    !SAFE_MARKER.test(target.marker.value)
  ) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID", field: "marker" });
  }
  if (
    typeof target.id !== "string" ||
    !SAFE_ROW_KEY.test(target.id) ||
    typeof target.provisioningAllowed !== "boolean" ||
    typeof target.reviewedNote !== "string" ||
    target.reviewedNote.trim() === "" ||
    // A justification is mandatory so the approval is never a bare value that a
    // future reviewer has to reverse-engineer.
    target.reviewedNote.length > 400
  ) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "expected" });
  }

  return freezeIssues(issues);
}

/**
 * Applies optional, non-secret environment pins to a reviewed target.
 *
 * The pins may only narrow what the reviewed registry already allows. They
 * exist so a maintainer can lock the preflight to one exact fingerprint during
 * a replacement window, without a code deploy; they can never widen the
 * approved set, so a misconfigured pin fails closed rather than opening a hole.
 */
export function narrowProductionDatabaseTargetIdentity(
  expected: ProductionDatabaseTargetIdentity,
  environment: Readonly<Record<string, string | undefined>>,
): ProductionDatabaseTargetNarrowResult {
  const fingerprint = safeTrim(environment.PRODUCTION_DATABASE_EXPECTED_FINGERPRINT);
  if (fingerprint !== undefined) {
    if (!FINGERPRINT.test(fingerprint)) {
      return Object.freeze({
        ok: false,
        code: "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID",
      });
    }
    if (!expected.clusterFingerprints.includes(fingerprint)) {
      return Object.freeze({
        ok: false,
        code: "PRODUCTION_DATABASE_EXPECTED_FINGERPRINT_INVALID",
      });
    }
  }

  const marker = safeTrim(environment.PRODUCTION_DATABASE_EXPECTED_MARKER);
  if (marker !== undefined && marker !== expected.marker.value) {
    return Object.freeze({
      ok: false,
      code: "PRODUCTION_DATABASE_EXPECTED_MARKER_INVALID",
    });
  }

  return Object.freeze({
    ok: true,
    target: Object.freeze({
      ...expected,
      ...(fingerprint === undefined ? {} : { clusterFingerprints: Object.freeze([fingerprint]) }),
    }),
  });
}

/**
 * The decision itself. Returns a fully frozen, deterministically ordered
 * result; the caller is expected to halt on `ok: false` and must not continue
 * to any mutation.
 */
export function auditProductionDatabaseIdentity(
  input: ProductionDatabaseIdentityAuditInput,
): ProductionDatabaseIdentityAuditResult {
  const { expected, observation } = input;
  const { target, server } = observation;
  const fingerprint = computeProductionDatabaseFingerprint(observation);
  const provisioned = observation.identityTablePresent;
  const issues: ProductionDatabaseIdentityIssue[] = [];

  if (expected === null) {
    issues.push({ code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING", field: "expected" });
  }

  const unconfigured = { host: null, port: null, database: null };
  const configured =
    expected === null
      ? unconfigured
      : Object.freeze({
          host: safeToken(expected.host),
          port: isValidPort(expected.port) ? expected.port : null,
          database: safeToken(expected.database),
        });

  if (expected !== null) {
    if (target.host !== expected.host) {
      issues.push({ code: "PRODUCTION_DATABASE_HOST_MISMATCH", field: "host" });
    }
    if (target.port !== expected.port) {
      issues.push({ code: "PRODUCTION_DATABASE_PORT_MISMATCH", field: "port" });
    }
    if (target.database !== expected.database) {
      issues.push({ code: "PRODUCTION_DATABASE_NAME_MISMATCH", field: "database" });
    }
    // The URL's database name is only trustworthy when the server confirms it.
    if (server.databaseName.toLowerCase() !== target.database) {
      issues.push({ code: "PRODUCTION_DATABASE_NAME_MISMATCH", field: "database" });
    }
  }

  if (!server.readOnly) {
    issues.push({ code: "PRODUCTION_DATABASE_READ_ONLY_REQUIRED", field: "readOnly" });
  }

  if (server.inRecovery) {
    issues.push({ code: "PRODUCTION_DATABASE_TARGET_IN_RECOVERY", field: "server" });
  }

  // With no expectation there is nothing to approve the fingerprint against, so
  // the fingerprint checks are skipped rather than reported as a mismatch. The
  // missing expectation is the root cause and is already reported above;
  // layering a derived "mismatch" on top of it would only obscure it.
  const fingerprintApproved =
    expected !== null &&
    fingerprint !== null &&
    expected.clusterFingerprints.includes(fingerprint);

  if (expected !== null) {
    if (fingerprint === null) {
      issues.push({
        code: "PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED",
        field: "clusterFingerprint",
      });
    } else if (!fingerprintApproved) {
      issues.push({
        code: "PRODUCTION_DATABASE_FINGERPRINT_MISMATCH",
        field: "clusterFingerprint",
      });
    }
  }

  if (expected !== null && provisioned) {
    if (observation.marker === null) {
      issues.push({ code: "PRODUCTION_DATABASE_MARKER_MISSING", field: "marker" });
    } else if (observation.marker !== expected.marker.value) {
      issues.push({ code: "PRODUCTION_DATABASE_MARKER_MISMATCH", field: "marker" });
    }
  } else if (expected !== null && !provisioned && !expected.provisioningAllowed) {
    // An unprovisioned target is only accepted while the reviewed registry
    // entry explicitly says provisioning is in progress. Host, name, and
    // fingerprint are still enforced above, so this cannot admit another
    // database — only the reviewed one before it has been migrated.
    issues.push({ code: "PRODUCTION_DATABASE_MARKER_MISSING", field: "marker" });
  }

  const frozenIssues = freezeIssues(issues);

  return Object.freeze({
    ok: frozenIssues.length === 0,
    action: frozenIssues.length === 0 ? "continue" : "halt",
    targetId: expected === null ? null : safeToken(expected.id),
    configured,
    observed: Object.freeze({
      database: safeToken(server.databaseName),
      serverAddress: server.serverAddress === null ? null : safeToken(server.serverAddress),
      serverPort: server.serverPort,
      inRecovery: server.inRecovery,
      readOnly: server.readOnly,
    }),
    fingerprint,
    fingerprintApproved,
    provisioned,
    issues: frozenIssues,
  });
}

/** Audit plus halt semantics: throws unless every check passed. */
export function assertProductionDatabaseIdentity(
  input: ProductionDatabaseIdentityAuditInput,
): ProductionDatabaseIdentityAuditResult {
  const result = auditProductionDatabaseIdentity(input);
  if (!result.ok) throw new ProductionDatabaseIdentityAuditError(result);
  return result;
}

/**
 * Guards the marker relation name before it is interpolated into SQL. The value
 * is a checked-in constant, never caller input; this makes that assumption
 * explicit and auditable rather than implicit.
 */
export function assertProductionDatabaseIdentityTableIdentifier(): string {
  if (
    !IDENTIFIER.test(PRODUCTION_DATABASE_IDENTITY_SCHEMA) ||
    !IDENTIFIER.test(PRODUCTION_DATABASE_IDENTITY_TABLE) ||
    PRODUCTION_DATABASE_IDENTITY_RELATION !==
      `${PRODUCTION_DATABASE_IDENTITY_SCHEMA}.${PRODUCTION_DATABASE_IDENTITY_TABLE}`
  ) {
    throw new Error("Production database identity table identifier is invalid");
  }
  return PRODUCTION_DATABASE_IDENTITY_RELATION;
}

function freezeIssues(
  issues: readonly ProductionDatabaseIdentityIssue[],
): readonly ProductionDatabaseIdentityIssue[] {
  const deduplicated = new Map<string, ProductionDatabaseIdentityIssue>();
  for (const issue of issues) {
    deduplicated.set(`${issue.code}:${issue.field ?? ""}`, Object.freeze({ ...issue }));
  }
  return Object.freeze(
    [...deduplicated.values()].sort(
      (left, right) =>
        compareText(left.code, right.code) || compareText(left.field ?? "", right.field ?? ""),
    ),
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function safeTrim(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function safeToken(value: string): string | null {
  return SAFE_TOKEN.test(value) ? value : null;
}
