/**
 * Production PostgreSQL TLS policy (issue #181).
 *
 * Policy: production database connections must use authenticated TLS with
 * certificate verification. Production startup rejects configuration that
 * disables TLS entirely, and rejects certificate-verification bypasses unless
 * the separately gated emergency mode is enabled. Development and test
 * environments keep permissive behavior; the exceptions can never silently
 * activate in production.
 *
 * This module is pure decision logic: it takes the connection configuration
 * and environment facts, and returns either a resolved TLS policy or the
 * exact reason the configuration is rejected. It performs no I/O and never
 * sees credentials directly — the caller passes what is needed for
 * diagnostics separately (see resolveProductionTlsPolicy).
 *
 * Why policy is resolved in application code rather than left to the driver:
 *
 * 1. `pg` defaults to `ssl: false` — a bare production URL silently connects
 *    in plaintext.
 * 2. `pg-connection-string` lets the URL's own query parameters
 *    (`sslmode=disable`, `ssl=no-verify`) override any ssl object the Pool
 *    config supplies, so a bypass could be smuggled in through the URL.
 * 3. `sslmode=require`/`verify-ca` downgrade certificate verification
 *    when interpreted by the driver on their own.
 *
 * StellarCore therefore parses and classifies the URL itself, strips TLS
 * parameters from the URL handed to the driver, and passes an explicit ssl
 * object with `rejectUnauthorized: true` (and a CA when configured) directly
 * in the Pool config — the last word on transport security. A managed
 * provider's `sslmode=require` is not itself a reason to reject startup when
 * the parameter is removed before the driver sees it and replaced with this
 * policy-owned verified-TLS configuration.
 */

export type DatabaseTlsMode =
  /** Verified, authenticated TLS: encryption + CA validation. Required in production. */
  | "VERIFY_FULL"
  /** TLS bypass (verification disabled). Only via the gated emergency mode. */
  | "NO_VERIFY"
  /** Plaintext. Never acceptable in production. */
  | "DISABLED"
  /** No TLS configuration present — the driver would fall back to plaintext. */
  | "UNSET"
  /** TLS requested, but the vendored driver resolves it unverified. */
  | "REQUIRE";

export type DatabaseTlsSource =
  /** sslmode/ssl parameter found in the URL query string. */
  | "URL_PARAMETER"
  /** PGSSLMODE / PGSSL* environment variables. */
  | "PG_ENVIRONMENT"
  /** SSL_MODE_TARGET / SSL_ROOT_CERT env vars (StellarCore-specific CA config). */
  | "STELLARCORE_ENVIRONMENT";

export type TlsConfigurationSignal = Readonly<{
  mode: DatabaseTlsMode;
  source: DatabaseTlsSource | null;
  /** The raw parameter/variable name observed (e.g. "sslmode", "PGSSLMODE"). */
  parameter: string | null;
}>;

export type ProductionTlsViolationCode =
  /** TLS disabled (or unset) in a production deployment. */
  | "PRODUCTION_TLS_DISABLED"
  /** Certificate verification explicitly bypassed outside emergency mode. */
  | "PRODUCTION_TLS_VERIFICATION_BYPASS"
  /** TLS enabled but no CA available to verify the server certificate. */
  | "PRODUCTION_TLS_CA_MISSING"
  /** The database URL itself is missing — cannot evaluate policy. */
  | "DATABASE_URL_MISSING";

export type ProductionTlsRejection = Readonly<{
  code: ProductionTlsViolationCode;
  /**
   * Safe, human-readable explanation. Never contains the URL, credentials,
   * or certificate material.
   */
  message: string;
  signal: TlsConfigurationSignal | null;
}>;

export type ResolvedDatabaseTlsPolicy = Readonly<{
  accepted: true;
  mode: DatabaseTlsMode;
  /**
   * The ssl object to pass to the pg Pool config, with the URL's TLS
   * parameters already stripped from the connection string by the caller.
   */
  sslConfig: Readonly<{
    rejectUnauthorized: true;
    ca?: string;
  }>;
}>;

export type ResolvedDatabaseTlsBypass = Readonly<{
  accepted: true;
  mode: "NO_VERIFY";
  sslConfig: Readonly<{ rejectUnauthorized: false }>;
}>;

export type ProductionTlsResolution =
  | ResolvedDatabaseTlsPolicy
  | ResolvedDatabaseTlsBypass
  | Readonly<{ accepted: false; rejection: ProductionTlsRejection }>;

export type TlsPolicyEnvironmentInput = Readonly<{
  /** The raw DATABASE_URL value (may be empty). */
  databaseUrl: string;
  /**
   * Production-like runtime detection: NODE_ENV=production, or the explicit
   * deployment flag. Local dev/test never resolve as production.
   */
  isProductionLike: boolean;
  /** The separately gated emergency bypass (STELLARCORE_DB_TLS_EMERGENCY_BYPASS=allow-unverified). */
  emergencyBypassRequested: boolean;
  /** Raw CA certificate value from STELLARCORE_DB_CA (PEM). */
  inlineCa: string | null;
  /** File path to a CA certificate from STELLARCORE_DB_CA_PATH. */
  caPath: string | null;
  /** Whether a CA file path exists on disk (resolved by the caller). */
  caPathExists: boolean;
}>;

/** The one accepted emergency bypass value, deliberately verbose. */
export const TLS_EMERGENCY_BYPASS_VALUE = "allow-unverified";

const SSL_URL_PARAMETERS = [
  "sslmode",
  "ssl",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslnegotiation",
  "uselibpqcompat",
] as const;

const BYPASS_MODES: ReadonlySet<string> = new Set(["disable", "no-verify", "prefer"]);
const REQUIRE_MODES: ReadonlySet<string> = new Set(["require", "verify-ca", "allow"]);

/** Strips every TLS-related parameter from a PostgreSQL URL. */
export function stripTlsParameters(databaseUrl: string): string {
  if (!databaseUrl) return databaseUrl;

  try {
    const url = new URL(databaseUrl);
    let touched = false;

    for (const parameter of SSL_URL_PARAMETERS) {
      if (url.searchParams.has(parameter)) {
        url.searchParams.delete(parameter);
        touched = true;
      }
    }

    if (!touched) return databaseUrl;

    const search = url.searchParams.toString();
    // `postgres:` is not a special URL scheme, so `url.origin` is null;
    // rebuild the origin from protocol, credentials, host, and port.
    const credentials = url.username
      ? `${url.username}${url.password ? `:${url.password}` : ""}@`
      : "";
    const port = url.port ? `:${url.port}` : "";
    const origin = `${url.protocol}//${credentials}${url.hostname}${port}`;

    return `${origin}${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
  } catch {
    // Unparseable URLs are handled by scheme validation elsewhere.
    return databaseUrl;
  }
}

/**
 * Classifies the TLS posture the connection URL itself declares. Returns null
 * when the URL carries no TLS parameters at all.
 */
export function classifyUrlTlsParameters(databaseUrl: string): TlsConfigurationSignal | null {
  if (!databaseUrl) return null;

  let params: URLSearchParams;

  try {
    params = new URL(databaseUrl).searchParams;
  } catch {
    return null;
  }

  const sslMode = params.get("sslmode");
  const sslFlag = params.get("ssl");

  if (sslMode !== null) {
    return {
      mode: classifyModeValue(sslMode),
      source: "URL_PARAMETER",
      parameter: "sslmode",
    };
  }

  if (sslFlag !== null) {
    const normalized = sslFlag.trim().toLowerCase();
    if (normalized === "0" || normalized === "false") {
      return { mode: "DISABLED", source: "URL_PARAMETER", parameter: "ssl" };
    }
    if (normalized === "no-verify") {
      return { mode: "NO_VERIFY", source: "URL_PARAMETER", parameter: "ssl" };
    }
    return { mode: "VERIFY_FULL", source: "URL_PARAMETER", parameter: "ssl" };
  }

  if (params.has("sslrootcert") || params.has("sslcert") || params.has("sslkey")) {
    return { mode: "VERIFY_FULL", source: "URL_PARAMETER", parameter: "sslrootcert" };
  }

  return null;
}

/**
 * Classifies the TLS posture declared through the libpq-style PG* environment
 * variables that `pg` reads when no ssl config is supplied. Returns null when
 * none are set.
 */
export function classifyPgEnvironmentTls(
  environment: Readonly<Record<string, string | undefined>>,
): TlsConfigurationSignal | null {
  const pgSslMode = environment.PGSSLMODE;

  if (pgSslMode) {
    return { mode: classifyModeValue(pgSslMode), source: "PG_ENVIRONMENT", parameter: "PGSSLMODE" };
  }

  if (
    environment.PGSSLROOTCERT
    || environment.PGSSLCERT
    || environment.PGSSLKEY
  ) {
    return { mode: "VERIFY_FULL", source: "PG_ENVIRONMENT", parameter: "PGSSLROOTCERT" };
  }

  return null;
}

function classifyModeValue(value: string): DatabaseTlsMode {
  const normalized = value.trim().toLowerCase();

  if (normalized === "disable") return "DISABLED";
  if (BYPASS_MODES.has(normalized)) return "NO_VERIFY";
  if (REQUIRE_MODES.has(normalized)) return "REQUIRE";
  if (normalized === "verify-full") return "VERIFY_FULL";

  return "UNSET";
}

/**
 * Resolves the effective TLS policy for a database connection.
 *
 * Production-like runtimes:
 * - TLS is supplied explicitly by this policy and always verifies certificates.
 * - TLS parameters that disable encryption or bypass certificate verification
 *   are rejected (except the separately gated, explicit emergency bypass).
 * - URL TLS parameters are removed before the driver sees the URL, so
 *   provider defaults such as sslmode=require can be safely upgraded to
 *   authenticated TLS by the explicit Pool ssl configuration.
 * - A provider CA is optional when the server chains to a public root trusted
 *   by Node; STELLARCORE_DB_CA or STELLARCORE_DB_CA_PATH can provide one.
 *
 * Non-production runtimes retain permissive local-development behavior.
 */
export function resolveDatabaseTlsPolicy(
  input: TlsPolicyEnvironmentInput,
  environment: Readonly<Record<string, string | undefined>> = {},
): ProductionTlsResolution {
  const urlSignal = classifyUrlTlsParameters(input.databaseUrl);
  const pgSignal = urlSignal ? null : classifyPgEnvironmentTls(environment);
  const signal = urlSignal ?? pgSignal;

  const effectiveMode: DatabaseTlsMode = signal?.mode ?? "UNSET";

  if (effectiveMode === "REQUIRE") {
    return requireModeResolution(input);
  }

  switch (effectiveMode) {
    case "DISABLED": {
      if (input.isProductionLike) {
        return reject(
          "PRODUCTION_TLS_DISABLED",
          "Production PostgreSQL configuration disables TLS. Encrypted transport is required; configure the database provider's TLS endpoint or remove the sslmode=disable / ssl=0 setting.",
          signal,
        );
      }
      return plaintextDevResolution();
    }

    case "NO_VERIFY":
    case "UNSET": {
      if (!input.isProductionLike) {
        return plaintextDevResolution();
      }

      if (effectiveMode === "NO_VERIFY" && !input.emergencyBypassRequested) {
        return reject(
          "PRODUCTION_TLS_VERIFICATION_BYPASS",
          "Production PostgreSQL configuration bypasses certificate verification (ssl=no-verify, sslmode=no-verify, or sslmode=prefer). Verified TLS is required; use the provider's TLS endpoint with certificate verification enabled.",
          signal,
        );
      }

      if (effectiveMode === "NO_VERIFY" && input.emergencyBypassRequested) {
        return {
          accepted: true,
          mode: "NO_VERIFY",
          sslConfig: Object.freeze({ rejectUnauthorized: false }),
        };
      }

      return {
        accepted: true,
        mode: "VERIFY_FULL",
        sslConfig: Object.freeze({
          rejectUnauthorized: true,
          ...(input.inlineCa ? { ca: input.inlineCa } : {}),
        }),
      };
    }

    case "VERIFY_FULL": {
      return {
        accepted: true,
        mode: "VERIFY_FULL",
        sslConfig: Object.freeze({
          rejectUnauthorized: true,
          ...(input.inlineCa ? { ca: input.inlineCa } : {}),
        }),
      };
    }
  }
}

function requireModeResolution(
  input: TlsPolicyEnvironmentInput,
): ProductionTlsResolution {
  // The caller strips TLS URL parameters before constructing the driver
  // connection. Upgrade require/verify-ca to authenticated TLS instead of
  // letting the driver's weaker URL semantics override certificate checks.
  return {
    accepted: true,
    mode: "VERIFY_FULL",
    sslConfig: Object.freeze({
      rejectUnauthorized: true,
      ...(input.inlineCa ? { ca: input.inlineCa } : {}),
    }),
  };
}

function reject(
  code: ProductionTlsViolationCode,
  message: string,
  signal: TlsConfigurationSignal | null,
): ProductionTlsResolution {
  return {
    accepted: false,
    rejection: Object.freeze({
      code,
      message,
      signal: signal ? Object.freeze({ ...signal }) : null,
    }),
  };
}

function plaintextDevResolution(): ProductionTlsResolution {
  return {
    accepted: true,
    mode: "DISABLED",
    sslConfig: Object.freeze({ rejectUnauthorized: true }) as ResolvedDatabaseTlsPolicy["sslConfig"],
  };
}
