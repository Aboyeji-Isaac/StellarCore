/**
 * Runtime configuration validation for StellarCore.
 *
 * Centralizes and validates StellarCore's runtime environment configuration so
 * invalid or missing production settings fail early with clear, safe diagnostics
 * instead of surfacing later inside unrelated request paths.
 *
 * Design rules:
 * - Single typed runtime configuration boundary documenting which variables
 *   are required by environment.
 * - Validate production-critical configuration once at startup.
 * - Preserve testability by allowing validated configuration to be injected
 *   or overridden in tests without mutating global state unpredictably.
 * - Return bounded diagnostics naming the invalid variable while never
 *   printing secret values.
 * - Define environment-specific requirements for development, test, preview,
 *   and production.
 */

import {
  DatabaseEnvironmentId,
  resolveRuntimeEnvironment,
} from "@/lib/config/environmentGuard";

/** All known runtime environment variables for StellarCore. */
export const RUNTIME_ENV_KEYS = [
  "DATABASE_URL",
  "CRON_SECRET",
  "STELLARCORE_ENVIRONMENT",
  "VERCEL_ENV",
  "NODE_ENV",
  "RATE_FRESHNESS_THRESHOLD_MS",
  "MIN_FRESH_SOURCES",
  "STELLARCORE_CONFIG_FINGERPRINT",
  "STELLARCORE_CONFIG_DRIFT_POLICY",
  "STELLARCORE_DEPLOYMENT_REVISION",
  "STELLARCORE_DB_CA",
  "STELLARCORE_DB_CA_PATH",
  "STELLARCORE_DB_TLS_EMERGENCY_BYPASS",
] as const;

export type RuntimeEnvKey = (typeof RUNTIME_ENV_KEYS)[number];

/** Environment variable value map for validation input. */
export type EnvInput = Readonly<Record<string, string | undefined>>;

/**
 * Validated runtime configuration.
 * All values are validated and normalized; secrets are present but never logged.
 */
export type RuntimeConfig = Readonly<{
  /** The declared runtime environment (production, preview, development, test, ci). */
  environment: DatabaseEnvironmentId;
  /** Source of the resolved environment. */
  environmentSource: "explicit-env" | "vercel-env" | "test-default";
  /** Validated PostgreSQL connection URL when configured. */
  databaseUrl: string | undefined;
  /** Cron secret for authenticated scheduled refresh (required in production). */
  cronSecret: string | undefined;
  /** Rate freshness threshold in milliseconds (default: 120000). */
  rateFreshnessThresholdMs: number;
  /** Minimum fresh independent sources required for a median (default: 2). */
  minFreshSources: number;
}>;

/** Validation error with bounded, secret-free diagnostics. */
export type RuntimeConfigError =
  | Readonly<{ ok: false; code: "MISSING_REQUIRED"; variable: RuntimeEnvKey; environment: DatabaseEnvironmentId }>
  | Readonly<{ ok: false; code: "INVALID_DATABASE_URL"; variable: "DATABASE_URL"; environment: DatabaseEnvironmentId; reason: string }>
  | Readonly<{ ok: false; code: "INVALID_NUMERIC"; variable: "RATE_FRESHNESS_THRESHOLD_MS" | "MIN_FRESH_SOURCES"; environment: DatabaseEnvironmentId; reason: string }>
  | Readonly<{ ok: false; code: "INVALID_ENVIRONMENT"; variable: "STELLARCORE_ENVIRONMENT" | "VERCEL_ENV"; environment: string }>
  | Readonly<{ ok: false; code: "MISSING_RUNTIME_ENVIRONMENT" }>
  | Readonly<{ ok: false; code: "RUNTIME_ENVIRONMENT_INVALID"; environment: string }>
  | Readonly<{ ok: false; code: "CRON_SECRET_REQUIRED_IN_PRODUCTION"; environment: "production" }>;

/** Result of runtime configuration validation. */
export type RuntimeConfigResult =
  | Readonly<{ ok: true; config: RuntimeConfig }>
  | RuntimeConfigError;

/** Default values for optional configuration. */
const DEFAULTS = Object.freeze({
  RATE_FRESHNESS_THRESHOLD_MS: 120_000,
  MIN_FRESH_SOURCES: 2,
} as const);

/** Environment-specific required variables. */
const REQUIRED_BY_ENVIRONMENT: Readonly<
  Record<DatabaseEnvironmentId, ReadonlySet<RuntimeEnvKey>>
> = Object.freeze({
  production: new Set<RuntimeEnvKey>(["DATABASE_URL", "CRON_SECRET"]),
  preview: new Set<RuntimeEnvKey>(["DATABASE_URL"]),
  development: new Set<RuntimeEnvKey>(["DATABASE_URL"]),
  test: new Set<RuntimeEnvKey>([]),
  ci: new Set<RuntimeEnvKey>(["DATABASE_URL"]),
});

/**
 * Validates a DATABASE_URL value.
 * Returns the validated URL or an error reason.
 */
function validateDatabaseUrl(value: string): { ok: true; url: string } | { ok: false; reason: string } {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }

  if (protocol === "prisma:" || protocol === "prisma+postgres:") {
    return { ok: false, reason: "must use postgres:// or postgresql:// with PrismaPg" };
  }

  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    return { ok: false, reason: "must use postgres:// or postgresql://" };
  }

  return { ok: true, url: value };
}

/**
 * Validates a numeric environment variable.
 */
function validateNumeric(
  value: string | undefined,
  variable: "RATE_FRESHNESS_THRESHOLD_MS" | "MIN_FRESH_SOURCES",
): { ok: true; value: number } | { ok: false; reason: string } {
  if (value === undefined) {
    return { ok: true, value: DEFAULTS[variable] };
  }

  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, reason: "must be a positive integer" };
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, reason: "must be a safe positive integer" };
  }

  if (variable === "MIN_FRESH_SOURCES" && parsed < 1) {
    return { ok: false, reason: "must be at least 1" };
  }

  return { ok: true, value: parsed };
}

/**
 * Validates the runtime configuration from environment variables.
 *
 * @param env - Environment variable map (defaults to process.env).
 * @returns Validated runtime configuration or a bounded error.
 */
export function validateRuntimeConfig(env: EnvInput = process.env): RuntimeConfigResult {
  // Resolve the runtime environment first.
  const envResult = resolveRuntimeEnvironment(env);
  if (!envResult.ok) {
    if (envResult.code === "RUNTIME_ENVIRONMENT_MISSING") {
      return { ok: false, code: "MISSING_RUNTIME_ENVIRONMENT" };
    }
    return {
      ok: false,
      code: "RUNTIME_ENVIRONMENT_INVALID",
      environment: env.STELLARCORE_ENVIRONMENT ?? env.VERCEL_ENV ?? "(unknown)",
    };
  }

  const environment = envResult.environment;

  // Validate required variables for this environment.
  const required = REQUIRED_BY_ENVIRONMENT[environment];
  for (const variable of required) {
    const value = env[variable];
    if (!value || value.trim() === "") {
      return {
        ok: false,
        code: "MISSING_REQUIRED",
        variable,
        environment,
      };
    }
  }

  // Validate DATABASE_URL format whenever it is configured. Test environments may
  // omit it until a database-backed module is actually used.
  const rawDatabaseUrl = env.DATABASE_URL?.trim();
  let databaseUrl: string | undefined;
  if (rawDatabaseUrl) {
    const databaseUrlValidation = validateDatabaseUrl(rawDatabaseUrl);
    if (!databaseUrlValidation.ok) {
      return {
        ok: false,
        code: "INVALID_DATABASE_URL",
        variable: "DATABASE_URL",
        environment,
        reason: databaseUrlValidation.reason,
      };
    }
    databaseUrl = databaseUrlValidation.url;
  }

  // Validate numeric options.
  const rateFreshnessValidation = validateNumeric(
    env.RATE_FRESHNESS_THRESHOLD_MS,
    "RATE_FRESHNESS_THRESHOLD_MS",
  );
  if (!rateFreshnessValidation.ok) {
    return {
      ok: false,
      code: "INVALID_NUMERIC",
      variable: "RATE_FRESHNESS_THRESHOLD_MS",
      environment,
      reason: rateFreshnessValidation.reason,
    };
  }

  const minFreshSourcesValidation = validateNumeric(env.MIN_FRESH_SOURCES, "MIN_FRESH_SOURCES");
  if (!minFreshSourcesValidation.ok) {
    return {
      ok: false,
      code: "INVALID_NUMERIC",
      variable: "MIN_FRESH_SOURCES",
      environment,
      reason: minFreshSourcesValidation.reason,
    };
  }

  // CRON_SECRET is required in production (checked above), but validate presence
  // for all environments where it's provided.
  const cronSecret = env.CRON_SECRET?.trim();
  if (environment === "production" && (!cronSecret || cronSecret === "")) {
    return {
      ok: false,
      code: "CRON_SECRET_REQUIRED_IN_PRODUCTION",
      environment: "production",
    };
  }

  // Determine environment source for diagnostics.
  let environmentSource: RuntimeConfig["environmentSource"];
  if (env.STELLARCORE_ENVIRONMENT?.trim()) {
    environmentSource = "explicit-env";
  } else if (env.VERCEL_ENV?.trim()) {
    environmentSource = "vercel-env";
  } else {
    environmentSource = "test-default";
  }

  const config: RuntimeConfig = Object.freeze({
    environment,
    environmentSource,
    databaseUrl,
    cronSecret,
    rateFreshnessThresholdMs: rateFreshnessValidation.value,
    minFreshSources: minFreshSourcesValidation.value,
  });

  return { ok: true, config };
}

/**
 * Asserts that the runtime configuration is valid, throwing on failure.
 * Use this at the application startup boundary.
 *
 * @param env - Environment variable map (defaults to process.env).
 * @returns The validated runtime configuration.
 * @throws {RuntimeConfigError} When validation fails, with a bounded message.
 */
export function assertRuntimeConfig(env: EnvInput = process.env): RuntimeConfig {
  const result = validateRuntimeConfig(env);
  if (!result.ok) {
    throw new RuntimeConfigValidationError(result);
  }
  return result.config;
}

let cachedRuntimeConfig: RuntimeConfig | undefined;

/**
 * Gets the validated runtime configuration, validating on first call and caching the result.
 * Use this for lazy initialization in modules that need the config at runtime.
 *
 * @param env - Environment variable map (defaults to process.env).
 * @returns The validated runtime configuration.
 * @throws {RuntimeConfigValidationError} When validation fails, with a bounded message.
 */
export function getRuntimeConfig(env?: EnvInput): RuntimeConfig {
  // Explicit inputs are intentionally never cached so tests and callers can
  // validate isolated configurations without contaminating process-wide state.
  if (env) return assertRuntimeConfig(env);

  if (!cachedRuntimeConfig) {
    cachedRuntimeConfig = assertRuntimeConfig(process.env);
  }
  return cachedRuntimeConfig;
}

/**
 * Clears the cached runtime configuration.
 * For test use only.
 */
export function resetRuntimeConfigCache(): void {
  cachedRuntimeConfig = undefined;
}

/**
 * Error thrown when runtime configuration validation fails.
 * Message is bounded and never includes secret values.
 */
export class RuntimeConfigValidationError extends Error {
  readonly code: RuntimeConfigError["code"];
  readonly variable?: RuntimeEnvKey;
  readonly environment: DatabaseEnvironmentId | string;
  readonly reason?: string;

  constructor(error: RuntimeConfigError) {
    const message = formatConfigErrorMessage(error);
    super(message);
    this.name = "RuntimeConfigValidationError";
    this.code = error.code;
    this.variable = "variable" in error ? error.variable : undefined;
    this.environment = "environment" in error ? error.environment : "(unknown)";
    this.reason = "reason" in error ? error.reason : undefined;
  }
}

/**
 * Formats a bounded, secret-free error message for a configuration error.
 */
function formatConfigErrorMessage(error: RuntimeConfigError): string {
  switch (error.code) {
    case "MISSING_REQUIRED":
      return `Missing required environment variable: ${error.variable} (required in ${error.environment} environment)`;
    case "INVALID_DATABASE_URL":
      return `Invalid DATABASE_URL: ${error.reason} (environment: ${error.environment})`;
    case "INVALID_NUMERIC":
      return `Invalid ${error.variable}: ${error.reason} (environment: ${error.environment})`;
    case "INVALID_ENVIRONMENT":
      return `Invalid environment value for ${error.variable}: "${error.environment}"`;
    case "MISSING_RUNTIME_ENVIRONMENT":
      return "Runtime environment not configured. Set STELLARCORE_ENVIRONMENT (production|preview|development|test|ci) or run on Vercel with VERCEL_ENV, or run under NODE_ENV=test.";
    case "RUNTIME_ENVIRONMENT_INVALID":
      return `Invalid runtime environment: "${error.environment}". Allowed: production, preview, development, test, ci`;
    case "CRON_SECRET_REQUIRED_IN_PRODUCTION":
      return "CRON_SECRET is required in production environment";
    default:
      return "Runtime configuration validation failed";
  }
}

/**
 * Creates a test-safe runtime configuration by overriding validated defaults.
 * Use this in tests to construct isolated valid/invalid configurations
 * without relying on ambient machine state.
 *
 * @param overrides - Partial configuration to override.
 * @returns A valid RuntimeConfig for testing.
 */
export function createTestRuntimeConfig(
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const baseConfig: RuntimeConfig = Object.freeze({
    environment: "test",
    environmentSource: "test-default",
    databaseUrl: "postgresql://test:test@localhost:5432/test",
    cronSecret: "test-secret",
    rateFreshnessThresholdMs: DEFAULTS.RATE_FRESHNESS_THRESHOLD_MS,
    minFreshSources: DEFAULTS.MIN_FRESH_SOURCES,
  });

  return Object.freeze({ ...baseConfig, ...overrides });
}

/**
 * Type guard for checking if a RuntimeConfigResult is successful.
 */
export function isRuntimeConfigOk(result: RuntimeConfigResult): result is { ok: true; config: RuntimeConfig } {
  return result.ok === true;
}

/**
 * Type guard for checking if a RuntimeConfigResult is an error.
 */
export function isRuntimeConfigError(result: RuntimeConfigResult): result is RuntimeConfigError {
  return result.ok === false;
}
