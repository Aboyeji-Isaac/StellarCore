/**
 * Restore drill target isolation guard (Issue #170, #351).
 *
 * Restore drills must run strictly against isolated non-production environments
 * (e.g. ephemeral local containers, isolated loopback test databases).
 * Pointing a restore drill at a production database would destroy or corrupt
 * production evidence.
 *
 * This module enforces:
 * 1. Configured production targets (environment identity, host, database name,
 *    or durable database stamp) are strictly rejected BEFORE any restore
 *    commands execute.
 * 2. Missing target identity is rejected (fails closed).
 * 3. Only approved isolated test targets ("test", "ci", "isolated-drill",
 *    "restore-drill") are accepted.
 * 4. Failure output and errors NEVER print credentials, passwords, or full
 *    connection URLs.
 * 5. Tests require zero production secrets.
 */

export const APPROVED_RESTORE_DRILL_ENVIRONMENTS = [
  "test",
  "ci",
  "isolated-drill",
  "restore-drill",
] as const;

export type ApprovedRestoreDrillEnvironment =
  (typeof APPROVED_RESTORE_DRILL_ENVIRONMENTS)[number];

export const APPROVED_LOOPBACK_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

const PRODUCTION_ENVIRONMENT_INDICATORS = new Set([
  "production",
  "prod",
  "live",
  "primary",
  "main",
]);

const PRODUCTION_HOST_PATTERNS = [
  /\bprod\b/i,
  /\bproduction\b/i,
  /\blive\b/i,
  /\bprimary\b/i,
  /\bmain\b/i,
  /\.supabase\.co$/i,
  /\.neon\.tech$/i,
  /\.aws\.com$/i,
  /\.rds\.amazonaws\.com$/i,
  /\.prisma\.io$/i,
  /\.azure\.com$/i,
  /\.planetscale\.com$/i,
];

const PRODUCTION_DB_NAME_PATTERNS = [
  /^production$/i,
  /^prod$/i,
  /.*_production$/i,
  /.*_prod$/i,
];

export type RestoreDrillTargetErrorCode =
  | "TARGET_IDENTITY_MISSING"
  | "TARGET_IDENTITY_PRODUCTION"
  | "TARGET_IDENTITY_NOT_APPROVED"
  | "TARGET_URL_INVALID"
  | "TARGET_URL_PRODUCTION"
  | "TARGET_HOST_NOT_ISOLATED"
  | "TARGET_DATABASE_PRODUCTION"
  | "DATABASE_STAMP_PRODUCTION"
  | "DATABASE_STAMP_MISMATCH";

export interface RestoreDrillTargetConfig {
  targetEnvironment?: string | null;
  targetDatabaseUrl?: string | null;
  databaseStamp?: string | null;
  allowNonLoopbackTestHost?: boolean;
}

export type RestoreDrillTargetVerdict =
  | Readonly<{
      ok: true;
      targetEnvironment: ApprovedRestoreDrillEnvironment;
      targetHost: string | null;
      targetDatabase: string | null;
    }>
  | Readonly<{
      ok: false;
      code: RestoreDrillTargetErrorCode;
      reason: string;
      targetEnvironment: string | null;
      targetHost: string | null;
      targetDatabase: string | null;
    }>;

/**
 * Sanitizes a PostgreSQL connection URL by stripping usernames, passwords,
 * tokens, and query parameters.
 * Output format: postgresql://***@host:port/database
 */
export function sanitizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname || "unknown-host";
    const port = parsed.port ? `:${parsed.port}` : "";
    const pathname = parsed.pathname || "";
    return `postgresql://***@${host}${port}${pathname}`;
  } catch {
    return "postgresql://***@sanitized-url";
  }
}

/**
 * Redacts any potential credentials, passwords, or full connection URLs from a
 * string. Used for safe logging and error reporting.
 */
export function redactSensitiveDetails(text: string): string {
  if (!text) return "";
  // Redact URLs with credentials (e.g. postgresql://user:pass@host)
  let cleaned = text.replace(
    /(postgres(?:ql)?:\/\/[^\s/@:]+):[^\s/@]+@([^\s/:]+)/gi,
    "$1:***@$2",
  );
  // Redact generic connection strings
  cleaned = cleaned.replace(
    /(postgres(?:ql)?:\/\/)[^\s@]+@/gi,
    "$1***@",
  );
  // Redact password assignment in key-value or query strings
  cleaned = cleaned.replace(
    /(password|passwd|pwd|secret|token)=([^\s;&]+)/gi,
    "$1=***",
  );
  return cleaned;
}

/**
 * Error thrown when a restore-drill target violates environment isolation.
 * Contains only redacted, bounded fields: no passwords or full connection URLs.
 */
export class RestoreDrillTargetError extends Error {
  readonly code: RestoreDrillTargetErrorCode;
  readonly targetEnvironment: string | null;
  readonly targetHost: string | null;
  readonly targetDatabase: string | null;
  readonly reason: string;

  constructor(
    code: RestoreDrillTargetErrorCode,
    reason: string,
    details: {
      targetEnvironment?: string | null;
      targetHost?: string | null;
      targetDatabase?: string | null;
    } = {},
  ) {
    const env = details.targetEnvironment?.trim() || "(unset)";
    const host = details.targetHost?.trim() || "(unset)";
    const db = details.targetDatabase?.trim() || "(unset)";

    // Secret-free bounded message
    const message =
      `Restore drill target rejected (${code}): ${reason} ` +
      `[targetEnvironment=${env}, host=${host}, database=${db}]. ` +
      `Restore commands refused.`;

    super(message);
    this.name = "RestoreDrillTargetError";
    this.code = code;
    this.reason = reason;
    this.targetEnvironment = details.targetEnvironment ?? null;
    this.targetHost = details.targetHost ?? null;
    this.targetDatabase = details.targetDatabase ?? null;
  }
}

/**
 * Validates a target identity configuration for restore drills.
 * Pure decision function: checks targetEnvironment, databaseUrl, and durable stamp.
 */
export function validateRestoreDrillTargetIdentity(
  config: RestoreDrillTargetConfig,
): RestoreDrillTargetVerdict {
  const rawEnv = config.targetEnvironment?.trim();
  let host: string | null = null;
  let database: string | null = null;

  // 1. Target environment identity check
  if (!rawEnv) {
    return Object.freeze({
      ok: false,
      code: "TARGET_IDENTITY_MISSING",
      reason:
        "Target environment identity is missing. Restore drills require an explicit isolated target identity.",
      targetEnvironment: null,
      targetHost: null,
      targetDatabase: null,
    });
  }

  const normalizedEnv = rawEnv.toLowerCase();

  // Refuse configured production identity
  if (PRODUCTION_ENVIRONMENT_INDICATORS.has(normalizedEnv)) {
    return Object.freeze({
      ok: false,
      code: "TARGET_IDENTITY_PRODUCTION",
      reason:
        "Target environment identity is production. Restore drills are strictly prohibited from targeting production databases.",
      targetEnvironment: normalizedEnv,
      targetHost: null,
      targetDatabase: null,
    });
  }

  // Refuse any non-approved environment (e.g. preview, development, staging)
  if (
    !(APPROVED_RESTORE_DRILL_ENVIRONMENTS as readonly string[]).includes(
      normalizedEnv,
    )
  ) {
    return Object.freeze({
      ok: false,
      code: "TARGET_IDENTITY_NOT_APPROVED",
      reason: `Target environment "${normalizedEnv}" is not an approved isolated test target. Approved: ${APPROVED_RESTORE_DRILL_ENVIRONMENTS.join(
        ", ",
      )}.`,
      targetEnvironment: normalizedEnv,
      targetHost: null,
      targetDatabase: null,
    });
  }

  // 2. Target Database URL validation (if provided)
  if (config.targetDatabaseUrl && config.targetDatabaseUrl.trim()) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.targetDatabaseUrl.trim());
    } catch {
      return Object.freeze({
        ok: false,
        code: "TARGET_URL_INVALID",
        reason: "Target database URL is malformed.",
        targetEnvironment: normalizedEnv,
        targetHost: null,
        targetDatabase: null,
      });
    }

    if (
      parsedUrl.protocol !== "postgres:" &&
      parsedUrl.protocol !== "postgresql:"
    ) {
      return Object.freeze({
        ok: false,
        code: "TARGET_URL_INVALID",
        reason: "Target database must use postgresql: protocol.",
        targetEnvironment: normalizedEnv,
        targetHost: null,
        targetDatabase: null,
      });
    }

    host = parsedUrl.hostname.toLowerCase();
    database = decodeURIComponent(parsedUrl.pathname.replace(/^\//, "")).toLowerCase();

    // Check host for production indicators
    for (const pattern of PRODUCTION_HOST_PATTERNS) {
      if (pattern.test(host)) {
        return Object.freeze({
          ok: false,
          code: "TARGET_URL_PRODUCTION",
          reason: `Target database host "${host}" matches a production host pattern.`,
          targetEnvironment: normalizedEnv,
          targetHost: host,
          targetDatabase: database || null,
        });
      }
    }

    // Restrict to loopback hosts unless explicitly allowed in test harness
    if (!APPROVED_LOOPBACK_HOSTS.has(host) && !config.allowNonLoopbackTestHost) {
      return Object.freeze({
        ok: false,
        code: "TARGET_HOST_NOT_ISOLATED",
        reason: `Target host "${host}" is not an approved loopback host (localhost / 127.0.0.1 / ::1).`,
        targetEnvironment: normalizedEnv,
        targetHost: host,
        targetDatabase: database || null,
      });
    }

    // Check database name for production indicators
    if (database) {
      for (const pattern of PRODUCTION_DB_NAME_PATTERNS) {
        if (pattern.test(database)) {
          return Object.freeze({
            ok: false,
            code: "TARGET_DATABASE_PRODUCTION",
            reason: `Target database name "${database}" indicates a production database.`,
            targetEnvironment: normalizedEnv,
            targetHost: host,
            targetDatabase: database,
          });
        }
      }
    }
  }

  // 3. Durable database stamp check (if checked against live database)
  if (config.databaseStamp && config.databaseStamp.trim()) {
    const stamp = config.databaseStamp.trim().toLowerCase();
    if (PRODUCTION_ENVIRONMENT_INDICATORS.has(stamp)) {
      return Object.freeze({
        ok: false,
        code: "DATABASE_STAMP_PRODUCTION",
        reason:
          "Target database has a durable production environment stamp. Refusing restore drill.",
        targetEnvironment: normalizedEnv,
        targetHost: host,
        targetDatabase: database || null,
      });
    }

    if (
      !(APPROVED_RESTORE_DRILL_ENVIRONMENTS as readonly string[]).includes(stamp)
    ) {
      return Object.freeze({
        ok: false,
        code: "DATABASE_STAMP_MISMATCH",
        reason: `Target database stamp "${stamp}" is not an approved isolated test target.`,
        targetEnvironment: normalizedEnv,
        targetHost: host,
        targetDatabase: database || null,
      });
    }
  }

  return Object.freeze({
    ok: true,
    targetEnvironment: normalizedEnv as ApprovedRestoreDrillEnvironment,
    targetHost: host,
    targetDatabase: database,
  });
}

/**
 * Asserts that the restore drill target identity is approved.
 * Throws a bounded, secret-free RestoreDrillTargetError on any violation.
 */
export function assertRestoreDrillTargetAllowed(
  config: RestoreDrillTargetConfig,
): Readonly<{
  targetEnvironment: ApprovedRestoreDrillEnvironment;
  targetHost: string | null;
  targetDatabase: string | null;
}> {
  const verdict = validateRestoreDrillTargetIdentity(config);
  if (!verdict.ok) {
    throw new RestoreDrillTargetError(verdict.code, verdict.reason, {
      targetEnvironment: verdict.targetEnvironment,
      targetHost: verdict.targetHost,
      targetDatabase: verdict.targetDatabase,
    });
  }
  return Object.freeze({
    targetEnvironment: verdict.targetEnvironment,
    targetHost: verdict.targetHost,
    targetDatabase: verdict.targetDatabase,
  });
}

/**
 * Resolves restore drill target configuration from environment variables.
 */
export function resolveRestoreDrillTargetFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RestoreDrillTargetConfig {
  const targetEnvironment =
    env.STELLARCORE_RESTORE_TARGET_ENVIRONMENT?.trim() ||
    env.RESTORE_TARGET_ENVIRONMENT?.trim() ||
    (env.NODE_ENV === "test" && !env.STELLARCORE_RESTORE_TARGET_ENVIRONMENT
      ? undefined
      : undefined);

  const targetDatabaseUrl =
    env.RESTORE_TARGET_DATABASE_URL?.trim() ||
    (env.STELLARCORE_RESTORE_TARGET_ENVIRONMENT ? env.DATABASE_URL?.trim() : undefined);

  return {
    targetEnvironment,
    targetDatabaseUrl,
  };
}

/**
 * Wraps execution of restore drill commands with the target identity guard.
 * Guarantees that target validation runs and rejects BEFORE executeRestore is called.
 */
export async function guardRestoreDrillExecution<T>(
  target: RestoreDrillTargetConfig,
  executeRestore: () => Promise<T>,
): Promise<T> {
  // Preflight guard: throws before executeRestore is ever called
  assertRestoreDrillTargetAllowed(target);
  return await executeRestore();
}
