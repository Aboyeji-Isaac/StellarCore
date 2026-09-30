import { createHash } from "crypto";
import { ANCHOR_REGISTRY } from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";
import { REVIEWED_LIVE_RATE_SOURCES } from "@/constants/liveRateSources";
import {
  assertStellarCoreConfiguration,
  auditStellarCoreConfiguration,
  type ConfigurationAuditResult,
  type StellarCoreConfigurationInput,
} from "@/lib/config/stellarCoreConfiguration";

export const CURRENT_STELLARCORE_CONFIGURATION = Object.freeze({
  anchors: ANCHOR_REGISTRY,
  corridors: CORRIDOR_REGISTRY,
  anchorCorridorMappings: ANCHOR_CORRIDOR_REGISTRY,
  reviewedLiveRateSources: REVIEWED_LIVE_RATE_SOURCES,
}) satisfies StellarCoreConfigurationInput);

export type ConfigurationFragment = {
  id: string;
  version: string;
};

export type ConfigurationFragmentInput = {
  id: string;
  version: string | number;
  secret?: string;
};

export type RuntimeConfigurationFragments = {
  anchors: ConfigurationFragmentInput[];
  corridors: ConfigurationFragmentInput[];
  anchorCorridorMappings: ConfigurationFragmentInput[];
  reviewedLiveRateSources: ConfigurationFragmentInput[];
};

export type RuntimeConfigurationFingerprint = {
  fingerprint: string;
  algorithm: "sha256";
  canonicalVersion: 1;
  deploymentRevision: string | null;
};

export type RuntimeConfigurationDriftResult = {
  matches: boolean;
  expected: string;
  actual: string;
  deploymentRevision: string | null;
};

export type RuntimeConfigurationDriftPolicy = "fail" | "degrade" | "warn";

export type RuntimeConfigurationDiagnostics = {
  fingerprint: string;
  algorithm: "sha256";
  canonicalVersion: 1;
  deploymentRevision: string | null;
  expectedFingerprint: string | null;
  driftDetected: boolean;
  driftPolicy: RuntimeConfigurationDriftPolicy;
  degraded: boolean;
};

export class RuntimeConfigurationDriftError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly deploymentRevision: string | null;

  constructor(result: RuntimeConfigurationDriftResult) {
    super(
      `Runtime configuration drift detected: expected ${result.expected} but observed ${result.actual}`,
    );
    this.name = "RuntimeConfigurationDriftError";
    this.expected = result.expected;
    this.actual = result.actual;
    this.deploymentRevision = result.deploymentRevision;
  }
}

function normalizeString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }

  return normalized;
}

function normalizeVersion(value: string | number, label: string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must be a finite number or string.`);
    }

    return String(value);
  }

  return normalizeString(value, label);
}

function normalizeFragment(
  fragment: ConfigurationFragmentInput,
  label: string,
): ConfigurationFragment {
  if (fragment === null || typeof fragment !== "object") {
    throw new TypeError(`${label} must be an object.`);
  }

  return {
    id: normalizeString(fragment.id, `${label}.id`),
    version: normalizeVersion(fragment.version, `${label}.version`),
  };
}

function normalizeFragments(
  fragments: ConfigurationFragmentInput[],
  label: string,
): ConfigurationFragment[] {
  if (!Array.isArray(fragments)) {
    throw new TypeError(`${label} must be an array.`);
  }

  return fragments
    .map((fragment, index) => normalizeFragment(fragment, `${label}[${index}]`))
    .sort((left, right) => {
      if (left.id !== right.id) {
        return left.id < right.id ? -1 : 1;
      }

      if (left.version !== right.version) {
        return left.version < right.version ? -1 : 1;
      }

      return 0;
    });
}

function assertUniqueFragments(
  fragments: ConfigurationFragment[],
  label: string,
): void {
  const seen = new Set<string>();

  for (const fragment of fragments) {
    const key = `${fragment.id}@${fragment.version}`;

    if (seen.has(key)) {
      throw new Error(`${label} contains duplicate fragment ${key}.`);
    }

    seen.add(key);
  }
}

function canonicalizeRuntimeConfiguration(
  fragments: RuntimeConfigurationFragments,
): {
  anchors: ConfigurationFragment[];
  corridors: ConfigurationFragment[];
  anchorCorridorMappings: ConfigurationFragment[];
  reviewedLiveRateSources: ConfigurationFragment[];
} {
  if (fragments === null || typeof fragments !== "object") {
    throw new TypeError("Runtime configuration fragments must be an object.");
  }

  const anchors = normalizeFragments(fragments.anchors, "anchors");
  const corridors = normalizeFragments(fragments.corridors, "corridors");
  const anchorCorridorMappings = normalizeFragments(
    fragments.anchorCorridorMappings,
    "anchorCorridorMappings",
  );
  const reviewedLiveRateSources = normalizeFragments(
    fragments.reviewedLiveRateSources,
    "reviewedLiveRateSources",
  );

  assertUniqueFragments(anchors, "anchors");
  assertUniqueFragments(corridors, "corridors");
  assertUniqueFragments(anchorCorridorMappings, "anchorCorridorMappings");
  assertUniqueFragments(reviewedLiveRateSources, "reviewedLiveRateSources");

  return {
    anchors,
    corridors,
    anchorCorridorMappings,
    reviewedLiveRateSources,
  };
}

function buildCanonicalPayload(
  fragments: RuntimeConfigurationFragments,
  deploymentRevision: string | null,
): string {
  const canonical = canonicalizeRuntimeConfiguration(fragments);

  return JSON.stringify({
    canonicalVersion: 1,
    deploymentRevision: deploymentRevision ?? null,
    anchors: canonical.anchors.map((fragment) => ({
      id: fragment.id,
      version: fragment.version,
    })),
    corridors: canonical.corridors.map((fragment) => ({
      id: fragment.id,
      version: fragment.version,
    })),
    anchorCorridorMappings: canonical.anchorCorridorMappings.map((fragment) => ({
      id: fragment.id,
      version: fragment.version,
    })),
    reviewedLiveRateSources: canonical.reviewedLiveRateSources.map((fragment) => ({
      id: fragment.id,
      version: fragment.version,
    })),
  });
}

export function computeRuntimeConfigurationFingerprint(
  fragments: RuntimeConfigurationFragments,
  deploymentRevision: string | null = null,
): RuntimeConfigurationFingerprint {
  const normalizedRevision =
    deploymentRevision === null
      ? null
      : normalizeString(deploymentRevision, "deploymentRevision");

  const payload = buildCanonicalPayload(fragments, normalizedRevision);
  const fingerprint = createHash("sha256").update(payload, "utf8").digest("hex");

  return {
    fingerprint,
    algorithm: "sha256",
    canonicalVersion: 1,
    deploymentRevision: normalizedRevision,
  };
}

export function detectRuntimeConfigurationDrift(
  expectedFingerprint: string,
  fragments: RuntimeConfigurationFragments,
  deploymentRevision: string | null = null,
): RuntimeConfigurationDriftResult {
  const normalizedExpected = normalizeString(
    expectedFingerprint,
    "expectedFingerprint",
  ).toLowerCase();
  const actual = computeRuntimeConfigurationFingerprint(
    fragments,
    deploymentRevision,
  );

  return {
    matches: actual.fingerprint === normalizedExpected,
    expected: normalizedExpected,
    actual: actual.fingerprint,
    deploymentRevision: actual.deploymentRevision,
  };
}

export function enforceRuntimeConfigurationDrift(
  result: RuntimeConfigurationDriftResult,
  policy: RuntimeConfigurationDriftPolicy,
): { degraded: boolean } {
  if (result.matches) {
    return { degraded: false };
  }

  if (policy === "fail") {
    throw new RuntimeConfigurationDriftError(result);
  }

  return { degraded: true };
}

export function buildRuntimeConfigurationDiagnostics(
  expectedFingerprint: string,
  fragments: RuntimeConfigurationFragments,
  deploymentRevision: string | null,
  policy: RuntimeConfigurationDriftPolicy,
): RuntimeConfigurationDiagnostics {
  const result = detectRuntimeConfigurationDrift(
    expectedFingerprint,
    fragments,
    deploymentRevision,
  );
  const enforcement = enforceRuntimeConfigurationDrift(result, policy);

  return {
    fingerprint: result.actual,
    algorithm: "sha256",
    canonicalVersion: 1,
    deploymentRevision: result.deploymentRevision,
    expectedFingerprint: result.expected,
    driftDetected: !result.matches,
    driftPolicy: policy,
    degraded: enforcement.degraded,
  };
}

export function auditCurrentStellarCoreConfiguration(): ConfigurationAuditResult {
  return auditStellarCoreConfiguration(CURRENT_STELLARCORE_CONFIGURATION);
}

export function assertCurrentStellarCoreConfiguration(): ConfigurationAuditResult {
  return assertStellarCoreConfiguration(CURRENT_STELLARCORE_CONFIGURATION);
}
