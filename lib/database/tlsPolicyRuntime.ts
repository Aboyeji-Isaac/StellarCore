import { existsSync, readFileSync } from "node:fs";
import {
  resolveDatabaseTlsPolicy,
  stripTlsParameters,
  TLS_EMERGENCY_BYPASS_VALUE,
  type ProductionTlsResolution,
} from "@/lib/database/tlsPolicy";

export type TlsPolicyRuntimeInput = Readonly<{
  /** The raw DATABASE_URL value. */
  databaseUrl: string | undefined;
  /** Full process environment (or an injected subset for tests). */
  environment: Readonly<Record<string, string | undefined>>;
  /** Load a CA from disk when a CA path is configured. Default true. */
  readFile?: boolean;
}>;

export type TlsPolicyRuntimeResult = Readonly<{
  resolution: ProductionTlsResolution;
  /**
   * The connection string to hand to the driver: identical to DATABASE_URL
   * but with all TLS parameters stripped, so the resolved ssl object is the
   * last word on transport security.
   */
  sanitizedConnectionString: string;
  /**
   * True when the emergency bypass gate is enabled with the exact required
   * value. Exposed so callers can log (safely) that a bypass is active.
   */
  emergencyBypassActive: boolean;
}>;

/**
 * Gathers the environment facts, loads optional CA material, resolves the
 * TLS policy, and produces the sanitized connection string. This is the
 * module `lib/dbClient.ts` consumes. CA content is read into the ssl config
 * and is never included in diagnostics.
 */
export function resolveDatabaseTlsPolicyForEnvironment(
  input: TlsPolicyRuntimeInput,
): TlsPolicyRuntimeResult {
  const environment = input.environment;
  const bypassValue = environment.STELLARCORE_DB_TLS_EMERGENCY_BYPASS;
  const emergencyBypassActive = bypassValue === TLS_EMERGENCY_BYPASS_VALUE;

  const inlineCa = environment.STELLARCORE_DB_CA ?? null;
  const caPath = environment.STELLARCORE_DB_CA_PATH ?? null;
  const readFile = input.readFile ?? true;
  const caPathExists = Boolean(caPath && readFile && existsSync(caPath));

  const resolution = resolveDatabaseTlsPolicy(
    {
      databaseUrl: input.databaseUrl ?? "",
      isProductionLike: isProductionLikeEnvironment(environment),
      emergencyBypassRequested: emergencyBypassActive,
      inlineCa,
      caPath,
      caPathExists,
    },
    environment,
  );

  const inlineCaForConfig = resolution.accepted && resolution.mode === "VERIFY_FULL"
    ? inlineCa
    : null;

  // File-based CA is loaded only when the policy accepted verified TLS.
  const caContent = resolution.accepted && resolution.mode === "VERIFY_FULL" && !inlineCaForConfig && caPath && caPathExists
    ? readFileSync(caPath, "utf8")
    : inlineCaForConfig;

  const resolutionWithCa: ProductionTlsResolution = resolution.accepted
    && resolution.mode === "VERIFY_FULL"
    && caContent
    ? {
        ...resolution,
        sslConfig: Object.freeze({
          rejectUnauthorized: true,
          ca: caContent,
        }),
      }
    : resolution;

  return Object.freeze({
    resolution: resolutionWithCa,
    sanitizedConnectionString: stripTlsParameters(input.databaseUrl ?? ""),
    emergencyBypassActive,
  });
}

/**
 * Production-like detection. NODE_ENV=production is the primary signal; the
 * explicit STELLARCORE_DEPLOYMENT=production flag covers runtimes that do not
 * set NODE_ENV. Local development and test never resolve as production.
 */
export function isProductionLikeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  if (environment.NODE_ENV === "production") return true;
  if (environment.STELLARCORE_DEPLOYMENT === "production") return true;

  return false;
}

export { TLS_EMERGENCY_BYPASS_VALUE };
