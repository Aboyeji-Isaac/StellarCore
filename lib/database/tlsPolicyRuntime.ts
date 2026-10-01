import { existsSync, readFileSync } from "node:fs";
import {
  resolveDatabaseTlsPolicy,
  stripTlsParameters,
  TLS_EMERGENCY_BYPASS_VALUE,
  type ProductionTlsResolution,
} from "@/lib/database/tlsPolicy";
import type { DatabaseEnvironmentId } from "@/lib/config/environmentGuard";

export type TlsPolicyRuntimeInput = Readonly<{
  databaseUrl: string | undefined;
  environmentId: DatabaseEnvironmentId;
  environment: Readonly<Record<string, string | undefined>>;
  readFile?: boolean;
}>;

export type TlsPolicyRuntimeResult = Readonly<{
  resolution: ProductionTlsResolution;
  sanitizedConnectionString: string;
  emergencyBypassActive: boolean;
}>;

export function resolveDatabaseTlsPolicyForEnvironment(
  input: TlsPolicyRuntimeInput,
): TlsPolicyRuntimeResult {
  const environment = input.environment;
  const emergencyBypassActive =
    input.environmentId === "production" &&
    environment.STELLARCORE_DB_TLS_EMERGENCY_BYPASS === TLS_EMERGENCY_BYPASS_VALUE;

  const inlineCa = environment.STELLARCORE_DB_CA?.trim() || null;
  const caPath = environment.STELLARCORE_DB_CA_PATH?.trim() || null;
  const readFile = input.readFile ?? true;
  const caPathExists = Boolean(caPath && readFile && existsSync(caPath));

  if (input.environmentId === "production" && caPath && !caPathExists) {
    return Object.freeze({
      resolution: Object.freeze({
        accepted: false as const,
        rejection: Object.freeze({
          code: "PRODUCTION_TLS_CA_MISSING",
          message:
            "Configured PostgreSQL CA file is unavailable. Provide a readable STELLARCORE_DB_CA_PATH or remove it to use the platform trust store.",
          signal: null,
        }),
      }),
      sanitizedConnectionString: stripTlsParameters(input.databaseUrl ?? ""),
      emergencyBypassActive,
    });
  }

  const resolution = resolveDatabaseTlsPolicy(
    {
      databaseUrl: input.databaseUrl ?? "",
      isProductionLike: input.environmentId === "production",
      emergencyBypassRequested: emergencyBypassActive,
      inlineCa,
      caPath,
      caPathExists,
    },
    environment,
  );

  const caContent =
    resolution.accepted &&
    resolution.mode === "VERIFY_FULL" &&
    !inlineCa &&
    caPath &&
    caPathExists
      ? readFileSync(caPath, "utf8")
      : inlineCa;

  const resolutionWithCa: ProductionTlsResolution =
    resolution.accepted && resolution.mode === "VERIFY_FULL" && caContent
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

export { TLS_EMERGENCY_BYPASS_VALUE };
