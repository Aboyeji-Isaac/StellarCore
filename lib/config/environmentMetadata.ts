/**
 * Public-safe environment metadata for StellarCore evidence consumers.
 *
 * Public evidence can be served by a production, preview, or test runtime.
 * Consumers need to know which environment produced what they are reading, but
 * that descriptor must be built from trusted server configuration only and must
 * never carry secret material.
 *
 * Design rules:
 * - Identity comes from the validated runtime configuration boundary
 *   (`validateRuntimeConfig`), never from request headers, hostnames, or URL
 *   contents.
 * - Missing or invalid configuration fails closed with a typed result, so a
 *   caller can omit the metadata instead of guessing.
 * - Preview and test configurations can never be labelled production by
 *   default: the label is the configured identity, and a production identity
 *   claimed through the test-only default source is rejected.
 * - Only environment identity, its configuration source, and a derived
 *   production flag are exposed. Connection strings, cron secrets, and other
 *   environment variables never appear in the metadata.
 */

import {
  isDatabaseEnvironmentId,
  type DatabaseEnvironmentId,
} from "@/lib/config/environmentGuard";
import {
  validateRuntimeConfig,
  type EnvInput,
  type RuntimeConfig,
} from "@/lib/config/runtimeConfig";

export const ENVIRONMENT_METADATA_VERSION = "stellarcore-environment-metadata-v1";

export const ENVIRONMENT_METADATA_SOURCES = [
  "explicit-env",
  "vercel-env",
  "test-default",
] as const;

export type EnvironmentMetadata = Readonly<{
  version: typeof ENVIRONMENT_METADATA_VERSION;
  /** Environment identity declared by trusted server configuration. */
  environment: DatabaseEnvironmentId;
  /** Which trusted configuration source declared the identity. */
  source: RuntimeConfig["environmentSource"];
  /** Derived flag; true only when the identity is exactly `production`. */
  isProduction: boolean;
}>;

export type EnvironmentMetadataFailureCode =
  /** No validated configuration was supplied, or validation failed. */
  | "ENVIRONMENT_METADATA_UNAVAILABLE"
  /** The supplied configuration carries an identity this module cannot trust. */
  | "ENVIRONMENT_METADATA_INVALID";

export type EnvironmentMetadataResult =
  | Readonly<{ ok: true; metadata: EnvironmentMetadata }>
  | Readonly<{ ok: false; code: EnvironmentMetadataFailureCode }>;

/**
 * Builds public environment metadata from an already validated runtime
 * configuration. The result is frozen and contains no secret values.
 *
 * The defensive checks make the boundary safe even when a caller injects a
 * configuration object that was not produced by `validateRuntimeConfig`.
 */
export function buildEnvironmentMetadata(
  config: RuntimeConfig | null | undefined,
): EnvironmentMetadataResult {
  if (!config) return failure("ENVIRONMENT_METADATA_UNAVAILABLE");

  if (!isDatabaseEnvironmentId(config.environment)) {
    return failure("ENVIRONMENT_METADATA_INVALID");
  }

  if (!isEnvironmentMetadataSource(config.environmentSource)) {
    return failure("ENVIRONMENT_METADATA_INVALID");
  }

  // The test-only default source resolves to `test` by construction. A config
  // claiming production through it is inconsistent and is refused rather than
  // published as production identity.
  if (
    config.environment === "production"
    && config.environmentSource === "test-default"
  ) {
    return failure("ENVIRONMENT_METADATA_INVALID");
  }

  return Object.freeze({
    ok: true as const,
    metadata: Object.freeze({
      version: ENVIRONMENT_METADATA_VERSION,
      environment: config.environment,
      source: config.environmentSource,
      isProduction: config.environment === "production",
    }),
  });
}

/**
 * Validates a synthetic or process environment and builds the metadata in one
 * step. Configuration failures become a typed `ok: false` result; this function
 * never throws, and it never falls back to a production identity.
 */
export function resolveEnvironmentMetadata(
  env: EnvInput = process.env,
): EnvironmentMetadataResult {
  const validated = validateRuntimeConfig(env);
  if (!validated.ok) return failure("ENVIRONMENT_METADATA_UNAVAILABLE");
  return buildEnvironmentMetadata(validated.config);
}

function failure(code: EnvironmentMetadataFailureCode): EnvironmentMetadataResult {
  return Object.freeze({ ok: false as const, code });
}

function isEnvironmentMetadataSource(
  value: unknown,
): value is RuntimeConfig["environmentSource"] {
  return (ENVIRONMENT_METADATA_SOURCES as readonly unknown[]).includes(value);
}
