/**
 * Environment identity guardrails (#143).
 *
 * Every StellarCore runtime declares which environment it runs in, and every
 * database it connects to carries a durable stamp naming the environment it
 * serves. This module verifies the two match before any evidence access and
 * fails closed when they do not. A preview or test runtime pointed at a
 * production-marked database cannot read or mutate a single evidence row.
 *
 * Design rules enforced here:
 * - Identity is always explicit configuration; it is never inferred from
 *   hostnames, URL contents, or DATABASE_URL substring matching.
 * - Production never falls back to another environment: an unstamped database
 *   or a missing runtime identity is a hard failure in production.
 * - Error messages name only the involved environment identities; they never
 *   contain database URLs, credentials, or connection strings.
 */

export const DATABASE_ENVIRONMENT_IDS = [
  "production",
  "preview",
  "development",
  "test",
  "ci",
] as const;

export type DatabaseEnvironmentId = (typeof DATABASE_ENVIRONMENT_IDS)[number];

export type RuntimeEnvironmentSource =
  | "explicit-env"
  | "vercel-env"
  | "test-default";

export type EnvironmentGuardError =
  | Readonly<{ ok: true; environment: DatabaseEnvironmentId }>
  | Readonly<{
      ok: false;
      code:
        | "RUNTIME_ENVIRONMENT_MISSING"
        | "RUNTIME_ENVIRONMENT_INVALID"
        | "DATABASE_STAMP_MISSING"
        | "DATABASE_STAMP_INVALID"
        | "ENVIRONMENT_MISMATCH";
      runtimeEnvironment: string | null;
      databaseEnvironment: string | null;
    }>;

/**
 * Resolves the declared runtime environment. Reads only explicit identity
 * variables; there is deliberately no hostname- or URL-derived inference.
 * Precedence: STELLARCORE_ENVIRONMENT, then VERCEL_ENV (Vercel's own
 * deployment metadata), then (in vitest/node-test runs only) "test".
 */
export function resolveRuntimeEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EnvironmentGuardError {
  const explicit = env.STELLARCORE_ENVIRONMENT?.trim();
  if (explicit) return parseEnvironmentId(explicit, "RUNTIME_ENVIRONMENT_INVALID");

  const vercel = env.VERCEL_ENV?.trim();
  if (vercel) return parseEnvironmentId(vercel, "RUNTIME_ENVIRONMENT_INVALID");

  if (env.NODE_ENV === "test") {
    return Object.freeze({ ok: true, environment: "test" });
  }

  return Object.freeze({
    ok: false,
    code: "RUNTIME_ENVIRONMENT_MISSING",
    runtimeEnvironment: null,
    databaseEnvironment: null,
  });
}

function parseEnvironmentId(
  value: string,
  invalidCode: Extract<
    Extract<EnvironmentGuardError, { ok: false }>["code"],
    "RUNTIME_ENVIRONMENT_INVALID"
  >,
): EnvironmentGuardError {
  const normalized = value.toLowerCase();
  if (!isDatabaseEnvironmentId(normalized)) {
    return Object.freeze({
      ok: false,
      code: invalidCode,
      runtimeEnvironment: null,
      databaseEnvironment: null,
    });
  }
  return Object.freeze({ ok: true, environment: normalized });
}

export function isDatabaseEnvironmentId(value: string): value is DatabaseEnvironmentId {
  return (DATABASE_ENVIRONMENT_IDS as readonly string[]).includes(value);
}

/**
 * The compatibility matrix. Returns true when a runtime of the given
 * environment may connect to a database stamped with the database environment.
 * The rule is strict equality: production uses production, preview uses preview,
 * and test/CI use their own isolated synthetic databases.
 */
export function isEnvironmentPairingAllowed(
  runtime: DatabaseEnvironmentId,
  database: DatabaseEnvironmentId,
): boolean {
  return runtime === database;
}

/**
 * Verifies a runtime against a database stamp. This is the pure decision
 * function; lib/environmentGuardDb.ts performs the stamp read.
 */
export function verifyEnvironmentPairing(
  runtimeEnvironment: DatabaseEnvironmentId,
  databaseEnvironment: string | null | undefined,
): EnvironmentGuardError {
  if (!databaseEnvironment || !databaseEnvironment.trim()) {
    return Object.freeze({
      ok: false,
      code: "DATABASE_STAMP_MISSING",
      runtimeEnvironment,
      databaseEnvironment: null,
    });
  }

  const stamp = databaseEnvironment.trim().toLowerCase();
  if (!isDatabaseEnvironmentId(stamp)) {
    return Object.freeze({
      ok: false,
      code: "DATABASE_STAMP_INVALID",
      runtimeEnvironment,
      databaseEnvironment: stamp,
    });
  }

  if (!isEnvironmentPairingAllowed(runtimeEnvironment, stamp)) {
    return Object.freeze({
      ok: false,
      code: "ENVIRONMENT_MISMATCH",
      runtimeEnvironment,
      databaseEnvironment: stamp,
    });
  }

  return Object.freeze({ ok: true, environment: runtimeEnvironment });
}

/**
 * Capability gate: some flows (scheduled capture, bootstrap, evidence
 * mutation) must additionally be denied in environments that cannot hold
 * evidence at all (test/CI) even when a database is correctly stamped.
 */
export function assertEvidenceCapability(
  environment: DatabaseEnvironmentId,
): void {
  if (!EVIDENCE_CAPABLE_ENVIRONMENTS.has(environment)) {
    throw new EnvironmentIsolationError(
      "ENVIRONMENT_CAPABILITY_DENIED",
      environment,
      environment,
    );
  }
}

export class EnvironmentIsolationError extends Error {
  readonly code: Extract<
    Extract<EnvironmentGuardError, { ok: false }>["code"],
    "ENVIRONMENT_MISMATCH" | "DATABASE_STAMP_MISSING" | "DATABASE_STAMP_INVALID" | "RUNTIME_ENVIRONMENT_MISSING" | "RUNTIME_ENVIRONMENT_INVALID"
  >;
  readonly runtimeEnvironment: string | null;
  readonly databaseEnvironment: string | null;

  constructor(
    code: EnvironmentIsolationError["code"],
    runtimeEnvironment: string | null,
    databaseEnvironment: string | null,
  ) {
    // Bounded, secret-free message: identities only, never URLs or credentials.
    super(
      `Environment isolation guard failed (${code}): runtime=${safe(runtimeEnvironment)} database=${safe(databaseEnvironment)}. Refusing database access.`,
    );
    this.name = "EnvironmentIsolationError";
    this.code = code;
    this.runtimeEnvironment = runtimeEnvironment;
    this.databaseEnvironment = databaseEnvironment;
  }
}

function safe(value: string | null): string {
  return value === null || value.trim() === "" ? "(unset)" : value;
}
