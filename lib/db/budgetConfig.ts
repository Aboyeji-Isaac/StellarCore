/**
 * Database resource-budget configuration.
 *
 * Every runtime database access is subject to the bounds defined here.
 * Each value has a documented unit, a finite safe range, and a default
 * suitable for a single Vercel serverless instance.
 *
 * ## Timeout ordering (inner → outer)
 *
 * ```
 * lock_timeout  <  statement_timeout  <  acquisitionTimeoutMs  <  transactionTimeoutMs
 * ```
 *
 * Each inner bound **must** be strictly less than its parent so that the
 * tightest limit fires first and propagates outward without ambiguity.
 *
 * ## Enforcement layers
 *
 * | Bound                   | Enforced by                                   |
 * |-------------------------|-----------------------------------------------|
 * | Pool size (`poolMax`)   | `pg.Pool` `max` option                        |
 * | Acquisition timeout     | `pg.Pool` `connectionTimeoutMillis` option     |
 * | Idle timeout            | `pg.Pool` `idleTimeoutMillis` option           |
 * | Statement timeout       | PostgreSQL `SET statement_timeout` per-conn    |
 * | Lock-wait timeout       | PostgreSQL `SET lock_timeout` per-conn         |
 * | Transaction timeout     | Prisma `$transaction` `timeout` option         |
 *
 * ## Deployment sizing
 *
 * Per-instance pool size × number of instances must not exceed
 * `(PostgreSQL max_connections − reserved)`. Example:
 *
 * - PostgreSQL `max_connections = 100`, reserve 5 for migrations/operators
 * - 10 serverless instances × `poolMax = 5` = 50 ≤ 95 ✓
 *
 * This module owns per-instance bounds only. Global/provider limits are
 * documented in the deployment guide, not enforced here.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validated, frozen database budget configuration. */
export type DatabaseBudgetConfig = Readonly<{
  /** Maximum connections in the pool. Range: [1, 100]. */
  poolMax: number;

  /** Milliseconds to wait for a free pool slot. Range: [100, 60_000]. */
  acquisitionTimeoutMs: number;

  /** Milliseconds before idle connections are evicted. Range: [1_000, 600_000]. */
  idleTimeoutMs: number;

  /** Server-side statement cancellation limit. Range: [500, 120_000]. */
  statementTimeoutMs: number;

  /** Server-side lock-wait cancellation limit. Range: [100, 60_000]. */
  lockTimeoutMs: number;

  /** Interactive-transaction time limit. Range: [1_000, 300_000]. */
  transactionTimeoutMs: number;
}>;

/** Input before validation — all fields optional, falls back to defaults. */
export type DatabaseBudgetInput = Partial<{
  poolMax: number;
  acquisitionTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  transactionTimeoutMs: number;
}>;

export type BudgetValidationError = Readonly<{
  field: string;
  message: string;
}>;

export type BudgetValidationResult =
  | Readonly<{ ok: true; config: DatabaseBudgetConfig }>
  | Readonly<{ ok: false; errors: readonly BudgetValidationError[] }>;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Defaults sized for a single Vercel serverless instance. */
export const DATABASE_BUDGET_DEFAULTS: DatabaseBudgetConfig = Object.freeze({
  poolMax: 5,
  acquisitionTimeoutMs: 5_000,
  idleTimeoutMs: 10_000,
  statementTimeoutMs: 15_000,
  lockTimeoutMs: 5_000,
  transactionTimeoutMs: 20_000,
});

// ---------------------------------------------------------------------------
// Validation ranges
// ---------------------------------------------------------------------------

type Range = Readonly<{ min: number; max: number }>;

const RANGES: Readonly<Record<keyof DatabaseBudgetConfig, Range>> = Object.freeze({
  poolMax: Object.freeze({ min: 1, max: 100 }),
  acquisitionTimeoutMs: Object.freeze({ min: 100, max: 60_000 }),
  idleTimeoutMs: Object.freeze({ min: 1_000, max: 600_000 }),
  statementTimeoutMs: Object.freeze({ min: 500, max: 120_000 }),
  lockTimeoutMs: Object.freeze({ min: 100, max: 60_000 }),
  transactionTimeoutMs: Object.freeze({ min: 1_000, max: 300_000 }),
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a partial input against the budget schema.
 *
 * Invalid or unlimited values are **never** silently accepted.
 * Missing fields fall back to {@link DATABASE_BUDGET_DEFAULTS}.
 */
export function validateBudgetConfig(
  input: DatabaseBudgetInput = {},
): BudgetValidationResult {
  const errors: BudgetValidationError[] = [];

  const resolved: Record<string, number> = {};

  for (const key of Object.keys(RANGES) as (keyof DatabaseBudgetConfig)[]) {
    const raw = input[key];
    const value = raw ?? DATABASE_BUDGET_DEFAULTS[key];
    const range = RANGES[key];

    if (!isFinitePositiveInteger(value) && key === "poolMax") {
      errors.push({ field: key, message: `${key} must be a finite positive integer, got ${String(value)}` });
      continue;
    }

    if (!isFinitePositive(value)) {
      errors.push({ field: key, message: `${key} must be a finite positive number, got ${String(value)}` });
      continue;
    }

    if (value < range.min || value > range.max) {
      errors.push({
        field: key,
        message: `${key} must be in [${range.min}, ${range.max}], got ${value}`,
      });
      continue;
    }

    resolved[key] = value;
  }

  // Early return if individual fields failed — ordering checks need all values.
  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  // Timeout ordering: lock < statement < acquisition < transaction
  const r = resolved as unknown as DatabaseBudgetConfig;

  if (r.lockTimeoutMs >= r.statementTimeoutMs) {
    errors.push({
      field: "lockTimeoutMs",
      message: `lockTimeoutMs (${r.lockTimeoutMs}) must be strictly less than statementTimeoutMs (${r.statementTimeoutMs})`,
    });
  }

  if (r.statementTimeoutMs >= r.transactionTimeoutMs) {
    errors.push({
      field: "statementTimeoutMs",
      message: `statementTimeoutMs (${r.statementTimeoutMs}) must be strictly less than transactionTimeoutMs (${r.transactionTimeoutMs})`,
    });
  }

  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze(errors) });
  }

  return Object.freeze({ ok: true, config: Object.freeze({ ...r }) });
}

// ---------------------------------------------------------------------------
// Environment parsing
// ---------------------------------------------------------------------------

/** Environment variable names mapped to config fields. */
const ENV_MAP: Readonly<Record<keyof DatabaseBudgetConfig, string>> = Object.freeze({
  poolMax: "DB_POOL_MAX",
  acquisitionTimeoutMs: "DB_POOL_ACQUISITION_TIMEOUT_MS",
  idleTimeoutMs: "DB_POOL_IDLE_TIMEOUT_MS",
  statementTimeoutMs: "DB_STATEMENT_TIMEOUT_MS",
  lockTimeoutMs: "DB_LOCK_TIMEOUT_MS",
  transactionTimeoutMs: "DB_TRANSACTION_TIMEOUT_MS",
});

/**
 * Parse database budget configuration from environment variables.
 *
 * Missing variables fall back to defaults. Non-numeric or explicitly
 * unlimited values (`0`, `Infinity`) cause validation failures.
 *
 * @throws {DatabaseBudgetConfigError} on any validation failure.
 */
export function parseBudgetConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DatabaseBudgetConfig {
  const input: DatabaseBudgetInput = {};
  const parseErrors: BudgetValidationError[] = [];

  for (const [field, envVar] of Object.entries(ENV_MAP) as [keyof DatabaseBudgetConfig, string][]) {
    const raw = env[envVar];
    if (raw === undefined || raw === "") continue;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      parseErrors.push({
        field,
        message: `Environment variable ${envVar}="${raw}" is not a finite number`,
      });
      continue;
    }

    input[field] = parsed;
  }

  if (parseErrors.length > 0) {
    throw new DatabaseBudgetConfigError(parseErrors);
  }

  // Check for conflicting URL parameters that would override our budget.
  const dbUrl = env["DATABASE_URL"];
  if (dbUrl) {
    const urlConflicts = detectUrlParameterConflicts(dbUrl);
    if (urlConflicts.length > 0) {
      throw new DatabaseBudgetConfigError(urlConflicts);
    }
  }

  const result = validateBudgetConfig(input);
  if (!result.ok) {
    throw new DatabaseBudgetConfigError(result.errors);
  }

  return result.config;
}

// ---------------------------------------------------------------------------
// URL parameter conflict detection
// ---------------------------------------------------------------------------

/**
 * Reject connection-string parameters that would silently override the
 * application-level budget policy. The budget module owns these settings;
 * specifying them in the URL would create ambiguous precedence.
 */
const CONFLICTING_URL_PARAMS = Object.freeze([
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
] as const);

function detectUrlParameterConflicts(url: string): BudgetValidationError[] {
  const errors: BudgetValidationError[] = [];
  try {
    const parsed = new URL(url);
    for (const param of CONFLICTING_URL_PARAMS) {
      if (parsed.searchParams.has(param)) {
        errors.push({
          field: "DATABASE_URL",
          message: `DATABASE_URL contains "${param}" parameter which conflicts with the application budget policy. Remove it from the URL and use the corresponding DB_* environment variable instead.`,
        });
      }
    }
  } catch {
    // URL validation is handled elsewhere (dbClient.ts).
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class DatabaseBudgetConfigError extends Error {
  readonly errors: readonly BudgetValidationError[];

  constructor(errors: readonly BudgetValidationError[]) {
    const summary = errors.map((e) => `  - ${e.field}: ${e.message}`).join("\n");
    super(`Invalid database budget configuration:\n${summary}`);
    this.name = "DatabaseBudgetConfigError";
    this.errors = Object.freeze([...errors]);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isFinitePositiveInteger(value: number): boolean {
  return isFinitePositive(value) && Number.isInteger(value);
}
