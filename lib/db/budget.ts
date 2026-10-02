/**
 * Typed, validated runtime database-budget policy.
 *
 * One configuration governs both runtime roles:
 *
 * - `read`  — public read-only API and dashboard reads.
 * - `write` — authenticated refresh, registry bootstrap, and reputation writes.
 *
 * Every bound is expressed in explicit units and has a finite safe range. There
 * is no "unlimited" value: a bound of zero, a negative number, or an
 * `Infinity`/`false`/`off` token is rejected rather than silently disabling the
 * policy. Missing variables fall back to a finite built-in default.
 *
 * Precedence for every numeric knob is:
 *
 *   1. profile-specific variable, e.g. `DB_READ_STATEMENT_TIMEOUT_MS`
 *   2. global variable, e.g. `DB_STATEMENT_TIMEOUT_MS`
 *   3. built-in finite default
 *
 * A variable that is present but invalid is an error; it never falls through to
 * the next level. Application name is configured once with `DB_APPLICATION_NAME`
 * and receives a `:<profile>` suffix so pool ownership is visible in
 * `pg_stat_activity`.
 */

export type DatabaseBudgetProfileName = "read" | "write";

export type DatabaseBudgetKnob =
  | "poolMax"
  | "connectionTimeoutMs"
  | "idleTimeoutMs"
  | "maxLifetimeSeconds"
  | "statementTimeoutMs"
  | "lockTimeoutMs"
  | "idleInTransactionTimeoutMs"
  | "interactiveTransactionTimeoutMs"
  | "interactiveTransactionMaxWaitMs";

export type DatabaseBudget = Readonly<
  Record<DatabaseBudgetKnob, number> & {
    profile: DatabaseBudgetProfileName;
    applicationName: string;
  }
>;

export type DatabaseBudgetConfiguration = Readonly<{
  read: DatabaseBudget;
  write: DatabaseBudget;
  /**
   * Configured application connections for a single process/instance
   * (`read.poolMax + write.poolMax`). Vercel fan-out is instance count times
   * this value; reserve capacity for migrations and operators separately.
   */
  totalPoolMax: number;
}>;

export type DatabaseBudgetIssueCode =
  | "EMPTY_VALUE"
  | "INVALID_APPLICATION_NAME"
  | "INVALID_PROFILE"
  | "INCONSISTENT_BUDGET"
  | "NOT_AN_INTEGER"
  | "NOT_FINITE"
  | "OUT_OF_RANGE"
  | "UNLIMITED_NOT_ALLOWED";

export type DatabaseBudgetIssue = Readonly<{
  code: DatabaseBudgetIssueCode;
  /** Environment variable or policy name the issue applies to. */
  variable: string;
  profile?: DatabaseBudgetProfileName;
  handle: DatabaseBudgetHandle;
}>;

export type DatabaseBudgetHandle =
  | DatabaseBudgetKnob
  | "applicationName"
  | "profile"
  | "lockTimeoutMs<=statementTimeoutMs"
  | "statementTimeoutMs<=interactiveTransactionTimeoutMs"
  | "interactiveTransactionMaxWaitMs<=interactiveTransactionTimeoutMs";

export type DatabaseBudgetAuditResult = Readonly<{
  ok: boolean;
  issues: readonly DatabaseBudgetIssue[];
  configuration: DatabaseBudgetConfiguration | null;
}>;

export class DatabaseBudgetConfigurationError extends Error {
  readonly code = "INVALID_DATABASE_BUDGET_CONFIGURATION";
  readonly issues: readonly DatabaseBudgetIssue[];

  constructor(issues: readonly DatabaseBudgetIssue[]) {
    super("Invalid database budget configuration");
    this.name = "DatabaseBudgetConfigurationError";
    this.issues = Object.freeze([...issues]);
  }
}

const MILLISECONDS = "milliseconds";
const SECONDS = "seconds";
const CONNECTIONS = "connections";

/**
 * Documented unit and inclusive safe range for every knob. Ranges are
 * deliberately finite: the maximums are well below any value that PostgreSQL
 * treats as "no timeout" and cap resource use per process.
 */
export const DATABASE_BUDGET_UNITS: Readonly<
  Record<DatabaseBudgetKnob, { unit: string; min: number; max: number }>
> = Object.freeze({
  poolMax: Object.freeze({ unit: CONNECTIONS, min: 1, max: 100 }),
  connectionTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 120_000 }),
  idleTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 1_000, max: 3_600_000 }),
  maxLifetimeSeconds: Object.freeze({ unit: SECONDS, min: 1, max: 86_400 }),
  statementTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 600_000 }),
  lockTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 600_000 }),
  idleInTransactionTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 600_000 }),
  interactiveTransactionTimeoutMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 600_000 }),
  interactiveTransactionMaxWaitMs: Object.freeze({ unit: MILLISECONDS, min: 100, max: 600_000 }),
});

const DEFAULTS: Readonly<
  Record<DatabaseBudgetProfileName, Readonly<Record<DatabaseBudgetKnob, number>>>
> = Object.freeze({
  read: Object.freeze({
    poolMax: 4,
    connectionTimeoutMs: 2_000,
    idleTimeoutMs: 30_000,
    maxLifetimeSeconds: 1_800,
    statementTimeoutMs: 3_000,
    lockTimeoutMs: 1_000,
    idleInTransactionTimeoutMs: 5_000,
    interactiveTransactionTimeoutMs: 3_000,
    interactiveTransactionMaxWaitMs: 1_000,
  }),
  write: Object.freeze({
    poolMax: 4,
    connectionTimeoutMs: 5_000,
    idleTimeoutMs: 30_000,
    maxLifetimeSeconds: 1_800,
    statementTimeoutMs: 15_000,
    lockTimeoutMs: 5_000,
    idleInTransactionTimeoutMs: 30_000,
    interactiveTransactionTimeoutMs: 20_000,
    interactiveTransactionMaxWaitMs: 5_000,
  }),
});

const ENV_SUFFIX: Readonly<Record<DatabaseBudgetKnob, string>> = Object.freeze({
  poolMax: "POOL_MAX",
  connectionTimeoutMs: "CONNECTION_TIMEOUT_MS",
  idleTimeoutMs: "POOL_IDLE_TIMEOUT_MS",
  maxLifetimeSeconds: "POOL_MAX_LIFETIME_SECONDS",
  statementTimeoutMs: "STATEMENT_TIMEOUT_MS",
  lockTimeoutMs: "LOCK_TIMEOUT_MS",
  idleInTransactionTimeoutMs: "IDLE_IN_TRANSACTION_TIMEOUT_MS",
  interactiveTransactionTimeoutMs: "INTERACTIVE_TRANSACTION_TIMEOUT_MS",
  interactiveTransactionMaxWaitMs: "INTERACTIVE_TRANSACTION_MAX_WAIT_MS",
});

const PROFILE_PREFIX: Readonly<Record<DatabaseBudgetProfileName, string>> = Object.freeze({
  read: "DB_READ",
  write: "DB_WRITE",
});

const GLOBAL_PREFIX = "DB";
const APPLICATION_NAME_VARIABLE = "DB_APPLICATION_NAME";
const DEFAULT_APPLICATION_NAME = "stellarcore";
const APPLICATION_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const POSTGRES_APPLICATION_NAME_MAX_LENGTH = 63;

const UNLIMITED_TOKENS = new Set([
  "0",
  "false",
  "off",
  "none",
  "unlimited",
  "infinity",
  "nan",
]);

/**
 * Environment variable names for one knob at the global level and for each
 * profile. Exposed so deployment docs and tests can reference the exact names.
 */
export function databaseBudgetEnvironmentVariables(
  knob: DatabaseBudgetKnob,
): Readonly<{ global: string; read: string; write: string }> {
  const suffix = ENV_SUFFIX[knob];
  return Object.freeze({
    global: `${GLOBAL_PREFIX}_${suffix}`,
    read: `${PROFILE_PREFIX.read}_${suffix}`,
    write: `${PROFILE_PREFIX.write}_${suffix}`,
  });
}

export function databaseBudgetProfileEnvPrefix(
  profile: DatabaseBudgetProfileName,
): string {
  return PROFILE_PREFIX[profile];
}

export const DATABASE_BUDGET_APPLICATION_NAME_VARIABLE = APPLICATION_NAME_VARIABLE;

export function databaseBudgetDefaults(
  profile: DatabaseBudgetProfileName,
): Readonly<Record<DatabaseBudgetKnob, number>> {
  return DEFAULTS[profile];
}

/**
 * Parses and validates a full configuration. Throws
 * `DatabaseBudgetConfigurationError` when any issue is present.
 */
export function parseDatabaseBudgetConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseBudgetConfiguration {
  const result = auditDatabaseBudgetConfiguration(source);
  if (!result.ok || !result.configuration) {
    throw new DatabaseBudgetConfigurationError(result.issues);
  }
  return result.configuration;
}

/** Non-throwing audit used by tests, tooling, and startup diagnostics. */
export function auditDatabaseBudgetConfiguration(
  source: Readonly<Record<string, string | undefined>> = process.env,
): DatabaseBudgetAuditResult {
  const issues: DatabaseBudgetIssue[] = [];
  const applicationNameBase = readApplicationName(source, issues);

  const read = buildProfile("read", source, applicationNameBase, issues);
  const write = buildProfile("write", source, applicationNameBase, issues);

  const frozen = Object.freeze(
    issues
      .sort(compareIssues)
      .map((issue) => Object.freeze({ ...issue })),
  );

  if (frozen.length > 0) {
    return Object.freeze({ ok: false, issues: frozen, configuration: null });
  }

  return Object.freeze({
    ok: true,
    issues: frozen,
    configuration: Object.freeze({
      read,
      write,
      totalPoolMax: read.poolMax + write.poolMax,
    }),
  });
}

/**
 * Validates a profile name. An unknown profile is a configuration error rather
 * than a silent fallback to `read`.
 */
export function requireDatabaseBudgetProfile(
  value: string | undefined,
): DatabaseBudgetProfileName {
  if (value === "read" || value === "write") return value;
  throw new DatabaseBudgetConfigurationError([
    Object.freeze({
      code: "INVALID_PROFILE",
      variable: "profile",
      handle: "profile",
    }),
  ]);
}

function buildProfile(
  profile: DatabaseBudgetProfileName,
  source: Readonly<Record<string, string | undefined>>,
  applicationNameBase: string,
  issues: DatabaseBudgetIssue[],
): DatabaseBudget {
  const readKnob = (knob: DatabaseBudgetKnob): number =>
    resolveKnob(profile, source, knob, issues);

  const values = {
    poolMax: readKnob("poolMax"),
    connectionTimeoutMs: readKnob("connectionTimeoutMs"),
    idleTimeoutMs: readKnob("idleTimeoutMs"),
    maxLifetimeSeconds: readKnob("maxLifetimeSeconds"),
    statementTimeoutMs: readKnob("statementTimeoutMs"),
    lockTimeoutMs: readKnob("lockTimeoutMs"),
    idleInTransactionTimeoutMs: readKnob("idleInTransactionTimeoutMs"),
    interactiveTransactionTimeoutMs: readKnob("interactiveTransactionTimeoutMs"),
    interactiveTransactionMaxWaitMs: readKnob("interactiveTransactionMaxWaitMs"),
  };

  auditProfileInvariants(profile, values, issues);

  const applicationName = `${applicationNameBase}:${profile}`;
  if (applicationName.length > POSTGRES_APPLICATION_NAME_MAX_LENGTH) {
    issues.push({
      code: "INVALID_APPLICATION_NAME",
      variable: APPLICATION_NAME_VARIABLE,
      profile,
      handle: "applicationName",
    });
  }

  return Object.freeze({
    profile,
    applicationName,
    ...values,
  });
}

function resolveKnob(
  profile: DatabaseBudgetProfileName,
  source: Readonly<Record<string, string | undefined>>,
  knob: DatabaseBudgetKnob,
  issues: DatabaseBudgetIssue[],
): number {
  const variable = databaseBudgetEnvironmentVariables(knob);
  const profileVariable = profile === "read" ? variable.read : variable.write;
  const profileRaw = source[profileVariable];

  if (profileRaw !== undefined) {
    return parseKnobValue(profileRaw, profileVariable, profile, knob, issues)
      ?? DEFAULTS[profile][knob];
  }

  const globalRaw = source[variable.global];
  if (globalRaw !== undefined) {
    return parseKnobValue(globalRaw, variable.global, profile, knob, issues)
      ?? DEFAULTS[profile][knob];
  }

  return DEFAULTS[profile][knob];
}

function parseKnobValue(
  raw: string,
  variable: string,
  profile: DatabaseBudgetProfileName,
  knob: DatabaseBudgetKnob,
  issues: DatabaseBudgetIssue[],
): number | null {
  const token = raw.trim();

  if (token.length === 0) {
    issues.push(issue("EMPTY_VALUE", variable, profile, knob));
    return null;
  }

  if (UNLIMITED_TOKENS.has(token.toLowerCase())) {
    issues.push(issue("UNLIMITED_NOT_ALLOWED", variable, profile, knob));
    return null;
  }

  if (!/^[0-9]+$/.test(token)) {
    issues.push(issue("NOT_AN_INTEGER", variable, profile, knob));
    return null;
  }

  const value = Number(token);
  if (!Number.isFinite(value)) {
    issues.push(issue("NOT_FINITE", variable, profile, knob));
    return null;
  }

  const { min, max } = DATABASE_BUDGET_UNITS[knob];
  if (value < min || value > max) {
    issues.push(issue("OUT_OF_RANGE", variable, profile, knob));
    return null;
  }

  return value;
}

function auditProfileInvariants(
  profile: DatabaseBudgetProfileName,
  values: Readonly<Record<DatabaseBudgetKnob, number>>,
  issues: DatabaseBudgetIssue[],
): void {
  if (values.lockTimeoutMs > values.statementTimeoutMs) {
    issues.push({
      code: "INCONSISTENT_BUDGET",
      variable: databaseBudgetEnvironmentVariables("lockTimeoutMs").global,
      profile,
      handle: "lockTimeoutMs<=statementTimeoutMs",
    });
  }
  if (values.statementTimeoutMs > values.interactiveTransactionTimeoutMs) {
    issues.push({
      code: "INCONSISTENT_BUDGET",
      variable: databaseBudgetEnvironmentVariables("interactiveTransactionTimeoutMs").global,
      profile,
      handle: "statementTimeoutMs<=interactiveTransactionTimeoutMs",
    });
  }
  if (values.interactiveTransactionMaxWaitMs > values.interactiveTransactionTimeoutMs) {
    issues.push({
      code: "INCONSISTENT_BUDGET",
      variable: databaseBudgetEnvironmentVariables("interactiveTransactionMaxWaitMs").global,
      profile,
      handle: "interactiveTransactionMaxWaitMs<=interactiveTransactionTimeoutMs",
    });
  }
}

function readApplicationName(
  source: Readonly<Record<string, string | undefined>>,
  issues: DatabaseBudgetIssue[],
): string {
  const raw = source[APPLICATION_NAME_VARIABLE];
  if (raw === undefined) return DEFAULT_APPLICATION_NAME;

  const token = raw.trim();
  if (token.length === 0) {
    issues.push({
      code: "EMPTY_VALUE",
      variable: APPLICATION_NAME_VARIABLE,
      handle: "applicationName",
    });
    return DEFAULT_APPLICATION_NAME;
  }

  if (!APPLICATION_NAME_PATTERN.test(token)) {
    issues.push({
      code: "INVALID_APPLICATION_NAME",
      variable: APPLICATION_NAME_VARIABLE,
      handle: "applicationName",
    });
    return DEFAULT_APPLICATION_NAME;
  }

  return token;
}

function issue(
  code: DatabaseBudgetIssueCode,
  variable: string,
  profile: DatabaseBudgetProfileName,
  handle: DatabaseBudgetHandle,
): DatabaseBudgetIssue {
  return { code, variable, profile, handle };
}

function compareIssues(left: DatabaseBudgetIssue, right: DatabaseBudgetIssue): number {
  return (
    compareText(left.variable, right.variable) ||
    compareText(left.profile ?? "", right.profile ?? "") ||
    compareText(left.code, right.code) ||
    compareText(left.handle, right.handle)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
