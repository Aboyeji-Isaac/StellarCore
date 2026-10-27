import type {
  PersistedAnchorRecord,
  PersistedAssociationRecord,
  PersistedCorridorRecord,
  RegistryReconciliationInput,
  ReconciliationIssue,
  ReconciliationResult,
  RegistryRepairPlan,
  ReconciliationRepairAction,
  HistoricalEvidenceSummary,
  ReconciliationSummaryCounts,
  RegistryReconciliationReport,
} from "@/types/registryReconciliation";

/**
 * Read-only reconciliation between the reviewed source-controlled registries
 * and the persisted anchor/corridor configuration. Pure functions only: no
 * database, network, clock, or environment access, so output is fully
 * deterministic for identical inputs.
 *
 * Classification contract:
 * - MISSING_*  : registry lists it, database does not.
 * - UNEXPECTED_*: database has it, registry does not (retirement candidates).
 * - *_FIELD_MISMATCH: both exist but a reviewed value differs.
 * - MISSING/UNEXPECTED_ASSOCIATION: membership junction drift.
 * - ORPHANED_*_LINK: junction row pointing at a registry-unlisted row.
 * - ORPHANED_RATE_SNAPSHOT / ORPHANED_TRANSFER_OUTCOME: historical evidence
 *   attached to registry-unlisted rows; counted, never deleted.
 * - STALE_*: unexpected rows carrying historical evidence (retirement is
 *   evidence-affecting and therefore blocked from automated repair).
 */
const EMPTY_SUMMARY: ReconciliationSummaryCounts = Object.freeze({
  totalIssues: 0,
  missingAnchors: 0,
  missingCorridors: 0,
  unexpectedAnchors: 0,
  unexpectedCorridors: 0,
  anchorFieldMismatches: 0,
  corridorFieldMismatches: 0,
  missingAssociations: 0,
  unexpectedAssociations: 0,
  orphanedAnchorLinks: 0,
  orphanedCorridorLinks: 0,
  orphanedRateSnapshots: 0,
  orphanedTransferOutcomes: 0,
  staleAnchors: 0,
  staleCorridors: 0,
});

export function reconcileRegistryWithDatabase(
  input: RegistryReconciliationInput,
): ReconciliationResult {
  const issues: ReconciliationIssue[] = [];
  const registryAnchors = new Map(input.anchors.map((entry) => [entry.slug, entry]));
  const registryCorridors = new Map(input.corridors.map((entry) => [entry.slug, entry]));
  const persistedAnchors = new Map(
    input.persisted.anchors.map((record) => [record.slug, record]),
  );
  const persistedCorridors = new Map(
    input.persisted.corridors.map((record) => [record.slug, record]),
  );
  const persistedAssociations = new Set(
    input.persisted.associations.map(associationIdentity),
  );

  const desiredAssociations = new Set<string>();
  for (const mapping of input.anchorCorridorMappings) {
    for (const corridorSlug of mapping.corridorSlugs) {
      desiredAssociations.add(associationIdentity({
        anchorSlug: mapping.anchorSlug,
        corridorSlug,
      }));
    }
  }

  auditAnchors(input, registryAnchors, persistedAnchors, issues);
  auditCorridors(input, registryCorridors, persistedCorridors, issues);
  auditAssociations(
    desiredAssociations,
    persistedAssociations,
    registryAnchors,
    registryCorridors,
    issues,
  );

  const historicalEvidence = collectHistoricalEvidence(
    input,
    registryAnchors,
    registryCorridors,
    persistedAnchors,
    persistedCorridors,
    issues,
  );

  const summary = summarize(issues);
  return Object.freeze({
    drift: issues.length > 0,
    issues: Object.freeze(issues.sort(compareIssues)),
    summary,
    historicalEvidence,
  });
}

export function buildRegistryRepairPlan(
  result: ReconciliationResult,
): RegistryRepairPlan {
  const safeActions: ReconciliationRepairAction[] = [];
  const manualReviewActions: ReconciliationRepairAction[] = [];
  const skippedEvidenceDeletions: ReconciliationRepairAction[] = [];

  for (const issue of result.issues) {
    const action = planActionForIssue(issue);

    if (!action) continue;

    if (action.blockedByHistoricalEvidence) {
      skippedEvidenceDeletions.push(action);
    } else if (action.requiresManualReview) {
      manualReviewActions.push(action);
    } else {
      safeActions.push(action);
    }
  }

  return Object.freeze({
    safeActions: Object.freeze(safeActions),
    manualReviewActions: Object.freeze(manualReviewActions),
    skippedEvidenceDeletions: Object.freeze(skippedEvidenceDeletions),
    appliesWithoutManualAction:
      manualReviewActions.length === 0 && skippedEvidenceDeletions.length === 0,
  });
}

export function buildRegistryReconciliationReport(
  input: RegistryReconciliationInput,
): RegistryReconciliationReport {
  const result = reconcileRegistryWithDatabase(input);
  return Object.freeze({
    result,
    plan: buildRegistryRepairPlan(result),
  });
}

function auditAnchors(
  input: RegistryReconciliationInput,
  registryAnchors: Map<string, RegistryReconciliationInput["anchors"][number]>,
  persistedAnchors: Map<string, PersistedAnchorRecord>,
  issues: ReconciliationIssue[],
): void {
  for (const entry of input.anchors) {
    const persisted = persistedAnchors.get(entry.slug);

    if (!persisted) {
      issues.push(freezeIssue({
        code: "MISSING_ANCHOR",
        entity: "anchor",
        anchorSlug: entry.slug,
      }));
      continue;
    }

    for (const [field, expected, actual] of [
      ["name", entry.name, persisted.name],
      ["homeDomain", entry.homeDomain, persisted.homeDomain],
      [
        "tomlUrl",
        buildCanonicalTomlUrl(entry.homeDomain),
        persisted.tomlUrl,
      ],
    ] as const) {
      if (expected !== actual) {
        issues.push(freezeIssue({
          code: "ANCHOR_FIELD_MISMATCH",
          entity: "anchor",
          anchorSlug: entry.slug,
          field,
          expected,
          actual,
        }));
      }
    }
  }

  for (const record of input.persisted.anchors) {
    if (registryAnchors.has(record.slug)) continue;
    issues.push(freezeIssue({
      code: "UNEXPECTED_ANCHOR",
      entity: "anchor",
      anchorSlug: record.slug,
      historicalEvidenceCount:
        record.rateSnapshotCount + record.transferOutcomeCount,
    }));
  }
}

function auditCorridors(
  input: RegistryReconciliationInput,
  registryCorridors: Map<string, RegistryReconciliationInput["corridors"][number]>,
  persistedCorridors: Map<string, PersistedCorridorRecord>,
  issues: ReconciliationIssue[],
): void {
  for (const entry of input.corridors) {
    const persisted = persistedCorridors.get(entry.slug);

    if (!persisted) {
      issues.push(freezeIssue({
        code: "MISSING_CORRIDOR",
        entity: "corridor",
        corridorSlug: entry.slug,
      }));
      continue;
    }

    for (const [field, expected, actual] of [
      ["assetCodeFrom", entry.assetCodeFrom, persisted.assetCodeFrom],
      ["countryFrom", entry.countryFrom, persisted.countryFrom],
      ["assetCodeTo", entry.assetCodeTo, persisted.assetCodeTo],
      ["countryTo", entry.countryTo, persisted.countryTo],
    ] as const) {
      if (expected !== actual) {
        issues.push(freezeIssue({
          code: "CORRIDOR_FIELD_MISMATCH",
          entity: "corridor",
          corridorSlug: entry.slug,
          field,
          expected,
          actual,
        }));
      }
    }
  }

  for (const record of input.persisted.corridors) {
    if (registryCorridors.has(record.slug)) continue;
    issues.push(freezeIssue({
      code: "UNEXPECTED_CORRIDOR",
      entity: "corridor",
      corridorSlug: record.slug,
      historicalEvidenceCount:
        record.rateSnapshotCount + record.transferOutcomeCount,
    }));
  }
}

function auditAssociations(
  desiredAssociations: ReadonlySet<string>,
  persistedAssociations: ReadonlySet<string>,
  registryAnchors: ReadonlyMap<string, unknown>,
  registryCorridors: ReadonlyMap<string, unknown>,
  issues: ReconciliationIssue[],
): void {
  for (const identity of sortedIdentities(desiredAssociations)) {
    if (persistedAssociations.has(identity)) continue;

    const [anchorSlug, corridorSlug] = splitAssociationIdentity(identity);
    issues.push(freezeIssue({
      code: "MISSING_ASSOCIATION",
      entity: "anchor_corridor",
      anchorSlug,
      corridorSlug,
    }));
  }

  for (const identity of sortedIdentities(persistedAssociations)) {
    if (desiredAssociations.has(identity)) continue;

    const [anchorSlug, corridorSlug] = splitAssociationIdentity(identity);
    const anchorIsUnreviewed = !registryAnchors.has(anchorSlug);
    const corridorIsUnreviewed = !registryCorridors.has(corridorSlug);

    if (anchorIsUnreviewed || corridorIsUnreviewed) {
      // A junction pointing at a registry-unlisted row is orphaned evidence
      // context, not an independently actionable association repair. Anchors
      // win classification when both endpoints are unreviewed.
      issues.push(freezeIssue({
        code: anchorIsUnreviewed
          ? "ORPHANED_ANCHOR_LINK"
          : "ORPHANED_CORRIDOR_LINK",
        entity: "anchor_corridor",
        anchorSlug,
        corridorSlug,
      }));
      continue;
    }

    issues.push(freezeIssue({
      code: "UNEXPECTED_ASSOCIATION",
      entity: "anchor_corridor",
      anchorSlug,
      corridorSlug,
    }));
  }
}

function collectHistoricalEvidence(
  input: RegistryReconciliationInput,
  registryAnchors: ReadonlyMap<string, unknown>,
  registryCorridors: ReadonlyMap<string, unknown>,
  persistedAnchors: ReadonlyMap<string, PersistedAnchorRecord>,
  persistedCorridors: ReadonlyMap<string, PersistedCorridorRecord>,
  issues: ReconciliationIssue[],
): HistoricalEvidenceSummary {
  let rateSnapshotsAttachedToOrphanedAnchors = 0;
  let rateSnapshotsAttachedToOrphanedCorridors = 0;
  let transferOutcomesAttachedToOrphanedAnchors = 0;
  let transferOutcomesAttachedToOrphanedCorridors = 0;
  let orphanedAnchors = 0;
  let orphanedCorridors = 0;

  for (const record of input.persisted.anchors) {
    if (registryAnchors.has(record.slug)) continue;
    orphanedAnchors += 1;
    rateSnapshotsAttachedToOrphanedAnchors += record.rateSnapshotCount;
    transferOutcomesAttachedToOrphanedAnchors += record.transferOutcomeCount;

    if (record.rateSnapshotCount > 0) {
      issues.push(freezeIssue({
        code: "ORPHANED_RATE_SNAPSHOT",
        entity: "rate_snapshot",
        anchorSlug: record.slug,
        historicalEvidenceCount: record.rateSnapshotCount,
      }));
    }

    if (record.transferOutcomeCount > 0) {
      issues.push(freezeIssue({
        code: "ORPHANED_TRANSFER_OUTCOME",
        entity: "transfer_outcome",
        anchorSlug: record.slug,
        historicalEvidenceCount: record.transferOutcomeCount,
      }));
    }
  }

  for (const record of input.persisted.corridors) {
    if (registryCorridors.has(record.slug)) continue;
    orphanedCorridors += 1;
    rateSnapshotsAttachedToOrphanedCorridors += record.rateSnapshotCount;
    transferOutcomesAttachedToOrphanedCorridors += record.transferOutcomeCount;

    if (record.rateSnapshotCount > 0) {
      issues.push(freezeIssue({
        code: "ORPHANED_RATE_SNAPSHOT",
        entity: "rate_snapshot",
        corridorSlug: record.slug,
        historicalEvidenceCount: record.rateSnapshotCount,
      }));
    }

    if (record.transferOutcomeCount > 0) {
      issues.push(freezeIssue({
        code: "ORPHANED_TRANSFER_OUTCOME",
        entity: "transfer_outcome",
        corridorSlug: record.slug,
        historicalEvidenceCount: record.transferOutcomeCount,
      }));
    }
  }

  for (const issue of issues) {
    if (issue.code !== "UNEXPECTED_ANCHOR" && issue.code !== "UNEXPECTED_CORRIDOR") {
      continue;
    }

    // Rows carrying evidence are "stale" retirement candidates: deleting them
    // would remove historical observations, so plans must refuse automation.
    const isAnchor = issue.code === "UNEXPECTED_ANCHOR";
    const slug = isAnchor ? issue.anchorSlug! : issue.corridorSlug!;
    const record = (isAnchor ? persistedAnchors : persistedCorridors).get(slug)!;
    const evidenceCount = record.rateSnapshotCount + record.transferOutcomeCount;

    if (evidenceCount === 0) continue;

    issues.push(freezeIssue({
      code: isAnchor ? "STALE_ANCHOR" : "STALE_CORRIDOR",
      entity: isAnchor ? "anchor" : "corridor",
      ...(isAnchor ? { anchorSlug: slug } : { corridorSlug: slug }),
      historicalEvidenceCount: evidenceCount,
    }));
  }

  return Object.freeze({
    orphanedAnchors,
    orphanedCorridors,
    rateSnapshotsAttachedToOrphanedAnchors,
    rateSnapshotsAttachedToOrphanedCorridors,
    transferOutcomesAttachedToOrphanedAnchors,
    transferOutcomesAttachedToOrphanedCorridors,
  });
}

function planActionForIssue(
  issue: ReconciliationIssue,
): ReconciliationRepairAction | null {
  switch (issue.code) {
    case "MISSING_ANCHOR":
      return freezeAction({
        kind: "CREATE_ANCHOR",
        entity: "anchor",
        anchorSlug: issue.anchorSlug,
        requiresManualReview: false,
        blockedByHistoricalEvidence: false,
      });
    case "MISSING_CORRIDOR":
      return freezeAction({
        kind: "CREATE_CORRIDOR",
        entity: "corridor",
        corridorSlug: issue.corridorSlug,
        requiresManualReview: false,
        blockedByHistoricalEvidence: false,
      });
    case "ANCHOR_FIELD_MISMATCH":
      return freezeAction({
        kind: "UPDATE_ANCHOR",
        entity: "anchor",
        anchorSlug: issue.anchorSlug,
        field: issue.field,
        expected: issue.expected,
        requiresManualReview: false,
        blockedByHistoricalEvidence: false,
      });
    case "CORRIDOR_FIELD_MISMATCH":
      return freezeAction({
        kind: "UPDATE_CORRIDOR",
        entity: "corridor",
        corridorSlug: issue.corridorSlug,
        field: issue.field,
        expected: issue.expected,
        requiresManualReview: false,
        blockedByHistoricalEvidence: false,
      });
    case "MISSING_ASSOCIATION":
      return freezeAction({
        kind: "CREATE_ASSOCIATION",
        entity: "anchor_corridor",
        anchorSlug: issue.anchorSlug,
        corridorSlug: issue.corridorSlug,
        requiresManualReview: false,
        blockedByHistoricalEvidence: false,
      });
    case "UNEXPECTED_ASSOCIATION":
      // Removing a persisted membership changes reviewed relationship
      // evidence; keep it visible and require a maintainer decision.
      return freezeAction({
        kind: "REMOVE_ASSOCIATION",
        entity: "anchor_corridor",
        anchorSlug: issue.anchorSlug,
        corridorSlug: issue.corridorSlug,
        requiresManualReview: true,
        blockedByHistoricalEvidence: false,
      });
    case "STALE_ANCHOR":
    case "STALE_CORRIDOR":
      return freezeAction({
        kind: issue.code === "STALE_ANCHOR" ? "RETIRE_ANCHOR" : "RETIRE_CORRIDOR",
        entity: issue.code === "STALE_ANCHOR" ? "anchor" : "corridor",
        ...(issue.code === "STALE_ANCHOR"
          ? { anchorSlug: issue.anchorSlug }
          : { corridorSlug: issue.corridorSlug }),
        historicalEvidenceCount: issue.historicalEvidenceCount,
        requiresManualReview: true,
        blockedByHistoricalEvidence: true,
      });
    case "UNEXPECTED_ANCHOR":
    case "UNEXPECTED_CORRIDOR":
      // Evidence-free unexpected rows are still deletions; a maintainer must
      // confirm retirement even though no historical rows block the plan.
      return freezeAction({
        kind: issue.code === "UNEXPECTED_ANCHOR" ? "RETIRE_ANCHOR" : "RETIRE_CORRIDOR",
        entity: issue.code === "UNEXPECTED_ANCHOR" ? "anchor" : "corridor",
        ...(issue.code === "UNEXPECTED_ANCHOR"
          ? { anchorSlug: issue.anchorSlug }
          : { corridorSlug: issue.corridorSlug }),
        historicalEvidenceCount: 0,
        requiresManualReview: true,
        blockedByHistoricalEvidence: false,
      });
    case "ORPHANED_ANCHOR_LINK":
    case "ORPHANED_CORRIDOR_LINK":
    case "ORPHANED_RATE_SNAPSHOT":
    case "ORPHANED_TRANSFER_OUTCOME":
      // Junction and evidence rows are reported for visibility; they resolve
      // only through explicit maintainer retirement of the parent row.
      return null;
    default:
      return null;
  }
}

function summarize(issues: readonly ReconciliationIssue[]): ReconciliationSummaryCounts {
  const counts = { ...EMPTY_SUMMARY, totalIssues: issues.length };

  for (const issue of issues) {
    switch (issue.code) {
      case "MISSING_ANCHOR":
        counts.missingAnchors += 1;
        break;
      case "MISSING_CORRIDOR":
        counts.missingCorridors += 1;
        break;
      case "UNEXPECTED_ANCHOR":
        counts.unexpectedAnchors += 1;
        break;
      case "UNEXPECTED_CORRIDOR":
        counts.unexpectedCorridors += 1;
        break;
      case "ANCHOR_FIELD_MISMATCH":
        counts.anchorFieldMismatches += 1;
        break;
      case "CORRIDOR_FIELD_MISMATCH":
        counts.corridorFieldMismatches += 1;
        break;
      case "MISSING_ASSOCIATION":
        counts.missingAssociations += 1;
        break;
      case "UNEXPECTED_ASSOCIATION":
        counts.unexpectedAssociations += 1;
        break;
      case "ORPHANED_ANCHOR_LINK":
        counts.orphanedAnchorLinks += 1;
        break;
      case "ORPHANED_CORRIDOR_LINK":
        counts.orphanedCorridorLinks += 1;
        break;
      case "ORPHANED_RATE_SNAPSHOT":
        counts.orphanedRateSnapshots += 1;
        break;
      case "ORPHANED_TRANSFER_OUTCOME":
        counts.orphanedTransferOutcomes += 1;
        break;
      case "STALE_ANCHOR":
        counts.staleAnchors += 1;
        break;
      case "STALE_CORRIDOR":
        counts.staleCorridors += 1;
        break;
    }
  }

  return Object.freeze(counts);
}

function buildCanonicalTomlUrl(homeDomain: string): string {
  return `https://${homeDomain}/.well-known/stellar.toml`;
}

function associationIdentity(association: PersistedAssociationRecord): string {
  return `${association.anchorSlug}\u0000${association.corridorSlug}`;
}

function splitAssociationIdentity(identity: string): [string, string] {
  const separator = identity.indexOf("\u0000");
  return [identity.slice(0, separator), identity.slice(separator + 1)];
}

function sortedIdentities(identities: ReadonlySet<string>): readonly string[] {
  return [...identities].sort(compareText);
}

function compareIssues(
  left: ReconciliationIssue,
  right: ReconciliationIssue,
): number {
  return compareText(left.code, right.code)
    || compareText(left.anchorSlug ?? "", right.anchorSlug ?? "")
    || compareText(left.corridorSlug ?? "", right.corridorSlug ?? "")
    || compareText(left.field ?? "", right.field ?? "")
    || compareText(left.entity, right.entity);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freezeIssue(issue: ReconciliationIssue): ReconciliationIssue {
  return Object.freeze({ ...issue });
}

function freezeAction(
  action: ReconciliationRepairAction,
): ReconciliationRepairAction {
  return Object.freeze({ ...action });
}
