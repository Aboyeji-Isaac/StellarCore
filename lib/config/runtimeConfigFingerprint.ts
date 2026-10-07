import { createHash } from "node:crypto";

import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import type { RuntimeConfig } from "@/lib/config/runtimeConfig";

export const RUNTIME_CONFIG_FINGERPRINT_VERSION = "stellarcore-runtime-config-v1";

export type RuntimeConfigFingerprintPolicy = "fail" | "degrade" | "warn";

export type RuntimeConfigFingerprintMaterial = Readonly<{
  version: typeof RUNTIME_CONFIG_FINGERPRINT_VERSION;
  revision: string;
  runtime: Readonly<{
    environment: RuntimeConfig["environment"];
    rateFreshnessThresholdMs: number;
    minFreshSources: number;
    secretPresence: Readonly<{
      databaseUrl: boolean;
      cronSecret: boolean;
    }>;
  }>;
  reviewedConfiguration: Readonly<{
    anchors: readonly unknown[];
    corridors: readonly unknown[];
    anchorCorridorMappings: readonly unknown[];
    reviewedLiveRateSources: readonly unknown[];
  }>;
  policyIdentifiers: readonly string[];
}>;

export type RuntimeConfigFingerprintDiagnostics = Readonly<{
  activeFingerprint: string;
  expectedFingerprint: string | null;
  revision: string;
  policy: RuntimeConfigFingerprintPolicy;
  bound: boolean;
  driftDetected: boolean;
  degraded: boolean;
}>;

export class RuntimeConfigFingerprintError extends Error {
  readonly code:
    | "EXPECTED_FINGERPRINT_MISSING"
    | "RUNTIME_CONFIG_FINGERPRINT_MISMATCH";
  readonly diagnostics: RuntimeConfigFingerprintDiagnostics;

  constructor(
    code:
      | "EXPECTED_FINGERPRINT_MISSING"
      | "RUNTIME_CONFIG_FINGERPRINT_MISMATCH",
    diagnostics: RuntimeConfigFingerprintDiagnostics,
  ) {
    super(
      code === "EXPECTED_FINGERPRINT_MISSING"
        ? "Expected runtime configuration fingerprint is missing"
        : "Runtime configuration fingerprint mismatch",
    );
    this.name = "RuntimeConfigFingerprintError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export function buildRuntimeConfigFingerprintMaterial(
  config: RuntimeConfig,
  revision: string,
): RuntimeConfigFingerprintMaterial {
  const normalizedRevision = normalizeRevision(revision);

  return Object.freeze({
    version: RUNTIME_CONFIG_FINGERPRINT_VERSION,
    revision: normalizedRevision,
    runtime: Object.freeze({
      environment: config.environment,
      rateFreshnessThresholdMs: config.rateFreshnessThresholdMs,
      minFreshSources: config.minFreshSources,
      secretPresence: Object.freeze({
        databaseUrl: Boolean(config.databaseUrl),
        cronSecret: Boolean(config.cronSecret),
      }),
    }),
    reviewedConfiguration: Object.freeze({
      anchors: Object.freeze(sortCanonical(ANCHOR_REGISTRY)),
      corridors: Object.freeze(sortCanonical(CORRIDOR_REGISTRY)),
      anchorCorridorMappings: Object.freeze(
        sortCanonical(
          ANCHOR_CORRIDOR_REGISTRY.map((entry) => ({
            ...entry,
            corridorSlugs: [...entry.corridorSlugs].sort(),
          })),
        ),
      ),
      reviewedLiveRateSources: Object.freeze(
        sortCanonical(REVIEWED_LIVE_RATE_SOURCES),
      ),
    }),
    policyIdentifiers: Object.freeze([
      "runtime-config-schema:v1",
      "environment-isolation:v1",
      "registry-audit:v1",
      "raw-sql-boundaries:v1",
    ]),
  });
}

export function computeRuntimeConfigFingerprint(
  config: RuntimeConfig,
  revision: string,
): string {
  const material = buildRuntimeConfigFingerprintMaterial(config, revision);
  return createHash("sha256")
    .update(stableStringify(material))
    .digest("hex");
}

export function resolveDeploymentRevision(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return normalizeRevision(
    env.STELLARCORE_DEPLOYMENT_REVISION ??
      env.VERCEL_GIT_COMMIT_SHA ??
      env.GITHUB_SHA ??
      "local-unversioned",
  );
}

export function resolveRuntimeConfigFingerprintPolicy(
  config: RuntimeConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeConfigFingerprintPolicy {
  const raw = env.STELLARCORE_CONFIG_DRIFT_POLICY?.trim().toLowerCase();
  if (raw === "fail" || raw === "degrade" || raw === "warn") return raw;
  return config.environment === "production" ? "fail" : "warn";
}

export function verifyRuntimeConfigFingerprint(
  config: RuntimeConfig,
  options: Readonly<{
    expectedFingerprint?: string;
    revision?: string;
    policy?: RuntimeConfigFingerprintPolicy;
  }> = {},
): RuntimeConfigFingerprintDiagnostics {
  const revision = options.revision ?? resolveDeploymentRevision();
  const policy =
    options.policy ?? resolveRuntimeConfigFingerprintPolicy(config);
  const expected = normalizeExpectedFingerprint(options.expectedFingerprint);
  const active = computeRuntimeConfigFingerprint(config, revision);

  const diagnostics = Object.freeze({
    activeFingerprint: active,
    expectedFingerprint: expected,
    revision,
    policy,
    bound: expected !== null,
    driftDetected: expected !== null && expected !== active,
    degraded: expected !== null && expected !== active && policy === "degrade",
  }) satisfies RuntimeConfigFingerprintDiagnostics;

  if (expected === null) {
    if (config.environment === "production" && policy === "fail") {
      throw new RuntimeConfigFingerprintError(
        "EXPECTED_FINGERPRINT_MISSING",
        diagnostics,
      );
    }
    return diagnostics;
  }

  if (expected !== active && policy === "fail") {
    throw new RuntimeConfigFingerprintError(
      "RUNTIME_CONFIG_FINGERPRINT_MISMATCH",
      diagnostics,
    );
  }

  return diagnostics;
}

function normalizeExpectedFingerprint(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : normalized;
}

function normalizeRevision(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "local-unversioned";
  return normalized.slice(0, 128);
}

function sortCanonical<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    stableStringify(left).localeCompare(stableStringify(right)),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
