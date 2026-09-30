/**
 * Runtime environment and database identity guardrails (issue #143).
 *
 * Every deployment declares ONE explicit runtime environment identity and may
 * declare the database environment identity it expects to reach. The durable
 * database identity lives in the `environment_identity` table (one row,
 * written once by provisioning or scripts/mark-database-environment.ts) and is
 * checked at first database access. Pairings that are not allowed fail closed
 * BEFORE any evidence mutation, with bounded, secret-free errors.
 *
 * Design constraints from the issue:
 * - Runtime identity comes from an explicit env var, never inferred from
 *   hostname string matching.
 * - Errors never include database URLs or credentials.
 * - Production never silently falls back to another environment or to an
 *   unmarked/unknown database.
 * - The guard is fail-closed: unknown runtime, unknown database identity, and
 *   incompatible pairings are all rejected.
 */

export const RUNTIME_ENVIRONMENTS = Object.freeze([
  "production",
  "preview",
  "development",
  "test",
  "ci",
] as const);

export type RuntimeEnvironment = (typeof RUNTIME_ENVIRONMENTS)[number];

/** Error codes are bounded and safe to serialize/log; never carry secrets. */
export type EnvironmentIdentityErrorCode =
  | "RUNTIME_ENVIRONMENT_UNDECLARED"
  | "RUNTIME_ENVIRONMENT_INVALID"
  | "DATABASE_ENVIRONMENT_UNMARKED"
  | "DATABASE_ENVIRONMENT_MISMATCH";

export type RuntimeIdentity = Readonly<{
  environment: RuntimeEnvironment;
  /** Optional expected database environment; required for production. */
  expectsDatabaseEnvironment: RuntimeEnvironment;
}>;

export type DatabaseIdentity = Readonly<{
  /** Durable identity from environment_identity; null when unmarked. */
  environment: RuntimeEnvironment | null;
  markedAt: Date | null;
}>;

export type EnvironmentIdentityCheck =
  | Readonly<{ ok: true; runtime: RuntimeIdentity; database: DatabaseIdentity }>
  | Readonly<{ ok: false; code: EnvironmentIdentityErrorCode }>;

export class EnvironmentIdentityError extends Error {
  readonly code: EnvironmentIdentityErrorCode;
  /** Safe structured context: environments and codes only, never URLs. */
  readonly context: Readonly<Record<string, string>>;

  constructor(
    code: EnvironmentIdentityErrorCode,
    message: string,
    context: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "EnvironmentIdentityError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function isRuntimeEnvironment(value: unknown): value is RuntimeEnvironment {
  return (
    typeof value === "string" &&
    (RUNTIME_ENVIRONMENTS as readonly string[]).includes(value)
  );
}

/**
 * Resolves the explicit runtime identity. Production must additionally declare
 * the database environment it expects; every other environment defaults to
 * expecting a database marked for the same environment unless overridden.
 */
export function resolveRuntimeIdentity(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeIdentity {
  const raw = env.STELLARCORE_ENVIRONMENT;
  if (!raw || !raw.trim()) {
    throw new EnvironmentIdentityError(
      "RUNTIME_ENVIRONMENT_UNDECLARED",
      "STELLARCORE_ENVIRONMENT is required; set it to one of: " +
        RUNTIME_ENVIRONMENTS.join(", "),
    );
  }
  if (!isRuntimeEnvironment(raw)) {
    throw new EnvironmentIdentityError(
      "RUNTIME_ENVIRONMENT_INVALID",
      `STELLARCORE_ENVIRONMENT must be one of: ${RUNTIME_ENVIRONMENTS.join(", ")}`,
      { declared: raw.slice(0, 32) },
    );
  }

  const expectedRaw = env.STELLARCORE_EXPECTED_DATABASE_ENVIRONMENT;
  if (expectedRaw !== undefined && !isRuntimeEnvironment(expectedRaw)) {
    throw new EnvironmentIdentityError(
      "RUNTIME_ENVIRONMENT_INVALID",
      `STELLARCORE_EXPECTED_DATABASE_ENVIRONMENT must be one of: ${RUNTIME_ENVIRONMENTS.join(", ")}`,
    );
  }
  const expectsDatabaseEnvironment = expectedRaw ?? (raw === "production"
    ? "production"
    : raw);

  return Object.freeze({
    environment: raw,
    expectsDatabaseEnvironment: raw === "production" ? "production" : expectsDatabaseEnvironment,
  });
}

/**
 * The single compatibility matrix (issue #143 acceptance: every allowed and
 * forbidden pairing is enumerable). Production runtime ONLY matches a database
 * durably marked production. Every other runtime matches only its own mark.
 * Unknown database identity always fails closed.
 */
export function isPairingAllowed(
  runtime: RuntimeEnvironment,
  database: RuntimeEnvironment | null,
): boolean {
  return database !== null && database === runtime;
}

export function checkEnvironmentIdentity(
  runtime: RuntimeIdentity,
  database: DatabaseIdentity,
): EnvironmentIdentityCheck {
  if (!isPairingAllowed(runtime.environment, database.environment)) {
    const code = database.environment === null
      ? "DATABASE_ENVIRONMENT_UNMARKED"
      : "DATABASE_ENVIRONMENT_MISMATCH";
    return Object.freeze({
      ok: false,
      code,
    });
  }
  if (runtime.environment !== runtime.expectsDatabaseEnvironment) {
    // A runtime that explicitly expects a different database mark than its own
    // environment is misconfigured; fail closed rather than guess.
    return Object.freeze({ ok: false, code: "DATABASE_ENVIRONMENT_MISMATCH" });
  }
  return Object.freeze({ ok: true, runtime, database });
}

/** Bounded, secret-free operator-facing message for a failed pairing check. */
export function describeEnvironmentIdentityFailure(
  failure: Extract<EnvironmentIdentityCheck, { ok: false }>,
): string {
  switch (failure.code) {
    case "DATABASE_ENVIRONMENT_UNMARKED":
      return "Refusing to connect: the database environment identity is unmarked. " +
        "Mark the database with scripts/mark-database-environment.ts before use.";
    case "DATABASE_ENVIRONMENT_MISMATCH":
      return "Refusing to connect: the runtime environment and the durable database environment identity are incompatible. " +
        "Verify STELLARCORE_ENVIRONMENT and the database's environment_identity row.";
    case "RUNTIME_ENVIRONMENT_UNDECLARED":
    case "RUNTIME_ENVIRONMENT_INVALID":
      return "Refusing to connect: the runtime environment identity is not declared or invalid.";
  }
}
