import { PRODUCTION_DATABASE_IDENTITIES } from "@/constants/productionDatabaseIdentity";
import {
  auditProductionDatabaseTargetIdentity,
  type ProductionDatabaseIdentityIssue,
  type ProductionDatabaseTargetNarrowResult,
} from "@/lib/config/productionDatabaseIdentity";
import { narrowProductionDatabaseTargetIdentity } from "@/lib/config/productionDatabaseIdentity";
import type { ProductionDatabaseTargetIdentity } from "@/types/productionDatabaseIdentity";

/**
 * Binds the checked-in production database registry to the live guard.
 *
 * Mirrors the `auditStellarCoreConfiguration` /
 * `auditCurrentStellarCoreConfiguration` layering used for the anchor and
 * corridor registries: the pure decision lives in
 * `productionDatabaseIdentity.ts`, this module is the only place that reads
 * `constants/`, and the CLI wrappers stay thin.
 */

export type ProductionDatabaseIdentityRegistryIssue = Readonly<{
  code: string;
  targetId?: string;
  field?: string;
}>;

export type ProductionDatabaseIdentityRegistryResult = Readonly<{
  ok: boolean;
  targets: readonly ProductionDatabaseTargetIdentity[];
  issues: readonly ProductionDatabaseIdentityRegistryIssue[];
}>;

/**
 * The one approved production target.
 *
 * The registry is a list so a reviewed replacement window can name the outgoing
 * and incoming clusters explicitly, but StellarCore operates exactly one
 * production database, so the expected target is the entry with the reserved
 * `primary` row key. Anything else is a registry authoring mistake and is
 * reported as a halt by `runPreflight`, never silently substituted.
 */
export function currentProductionDatabaseTarget(): ProductionDatabaseTargetIdentity {
  const [primary] = PRODUCTION_DATABASE_IDENTITIES;
  return primary;
}

/** Validates the checked-in registry offline, with no database or network. */
export function auditCurrentProductionDatabaseIdentityRegistry(): ProductionDatabaseIdentityRegistryResult {
  const issues: ProductionDatabaseIdentityRegistryIssue[] = [];
  const seen = new Set<string>();

  for (const target of PRODUCTION_DATABASE_IDENTITIES) {
    for (const issue of auditProductionDatabaseTargetIdentity(target)) {
      issues.push({
        code: issue.code,
        targetId: target.id,
        ...(issue.field === undefined ? {} : { field: issue.field }),
      });
    }

    if (seen.has(target.id)) {
      issues.push({ code: "PRODUCTION_DATABASE_DUPLICATE_TARGET_ID", targetId: target.id });
    }
    seen.add(target.id);

    if (target.marker.rowKey !== target.id) {
      issues.push({
        code: "PRODUCTION_DATABASE_MARKER_ROW_KEY_MISMATCH",
        targetId: target.id,
        field: "marker",
      });
    }

    const fingerprints = new Set<string>();
    for (const fingerprint of target.clusterFingerprints) {
      if (fingerprints.has(fingerprint)) {
        issues.push({
          code: "PRODUCTION_DATABASE_DUPLICATE_CLUSTER_FINGERPRINT",
          targetId: target.id,
          field: "clusterFingerprint",
        });
      }
      fingerprints.add(fingerprint);
    }
  }

  const frozenIssues = Object.freeze(
    issues
      .map((issue) => Object.freeze({ ...issue }))
      .sort(
        (left, right) =>
          compareText(left.targetId ?? "", right.targetId ?? "") ||
          compareText(left.code, right.code) ||
          compareText(left.field ?? "", right.field ?? ""),
      ),
  );

  return Object.freeze({
    ok: frozenIssues.length === 0,
    targets: PRODUCTION_DATABASE_IDENTITIES,
    issues: frozenIssues,
  });
}

export type ProductionDatabaseExpectedResolution =
  | Readonly<{ ok: true; target: ProductionDatabaseTargetIdentity }>
  | Readonly<{ ok: false; code: string; issues: readonly ProductionDatabaseIdentityIssue[] }>;

/**
 * Resolves the expectation a preflight run will enforce, applying the optional
 * non-secret environment pins. Fails closed when the registry is unusable or
 * a pin disagrees with it.
 */
export function resolveExpectedProductionDatabaseTarget(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProductionDatabaseExpectedResolution {
  const registry = auditCurrentProductionDatabaseIdentityRegistry();
  if (!registry.ok) {
    return Object.freeze({
      ok: false,
      code: "PRODUCTION_DATABASE_EXPECTED_IDENTITY_MISSING",
      issues: Object.freeze([]),
    });
  }

  const narrowed: ProductionDatabaseTargetNarrowResult =
    narrowProductionDatabaseTargetIdentity(currentProductionDatabaseTarget(), environment);
  if (!narrowed.ok) {
    return Object.freeze({ ok: false, code: narrowed.code, issues: Object.freeze([]) });
  }

  return Object.freeze({ ok: true, target: narrowed.target });
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export { narrowProductionDatabaseTargetIdentity };
