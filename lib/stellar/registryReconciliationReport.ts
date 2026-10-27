import type {
  RegistryReconciliationReport,
  ReconciliationIssue,
  ReconciliationResult,
  RegistryRepairPlan,
} from "@/types/registryReconciliation";

/**
 * Deterministic human-readable rendering of a reconciliation result and its
 * proposed repair plan. Pure formatting over prebuilt values: it reads no
 * files, no database, and no environment.
 */
export function formatRegistryReconciliationReport(
  report: RegistryReconciliationReport,
): string {
  const lines: string[] = [];
  const { result, plan } = report;

  lines.push("StellarCore registry-to-database reconciliation");
  lines.push("===============================================");
  lines.push(
    result.drift
      ? `Drift detected: ${result.summary.totalIssues} issue(s).`
      : "No drift. Persisted configuration matches the reviewed registries.",
  );

  appendEvidenceSummary(lines, result.historicalEvidence);
  appendIssues(lines, result);
  appendRepairPlan(lines, plan);

  return `${lines.join("\n")}\n`;
}

function appendEvidenceSummary(
  lines: string[],
  evidence: ReconciliationResult["historicalEvidence"],
): void {
  const hasEvidence = evidence.orphanedAnchors > 0 || evidence.orphanedCorridors > 0;

  lines.push("");
  lines.push("Historical evidence");
  lines.push("-------------------");

  if (!hasEvidence) {
    lines.push("(none attached to registry-unlisted rows)");
    return;
  }

  lines.push(`  orphaned anchors: ${evidence.orphanedAnchors}`);
  lines.push(`  orphaned corridors: ${evidence.orphanedCorridors}`);
  lines.push(
    `  rate snapshots on orphaned anchors: ` +
      `${evidence.rateSnapshotsAttachedToOrphanedAnchors}`,
  );
  lines.push(
    `  rate snapshots on orphaned corridors: ` +
      `${evidence.rateSnapshotsAttachedToOrphanedCorridors}`,
  );
  lines.push(
    `  transfer outcomes on orphaned anchors: ` +
      `${evidence.transferOutcomesAttachedToOrphanedAnchors}`,
  );
  lines.push(
    `  transfer outcomes on orphaned corridors: ` +
      `${evidence.transferOutcomesAttachedToOrphanedCorridors}`,
  );
  lines.push(
    "  Repair plans never delete historical evidence automatically.",
  );
}

function appendIssues(
  lines: string[],
  result: ReconciliationResult,
): void {
  lines.push("");
  lines.push("Findings");
  lines.push("--------");

  if (result.issues.length === 0) {
    lines.push("(none)");
    return;
  }

  for (const issue of result.issues) {
    lines.push(formatIssue(issue));
  }
}

function formatIssue(issue: ReconciliationIssue): string {
  const subject =
    issue.anchorSlug && issue.corridorSlug
      ? `${issue.anchorSlug} <-> ${issue.corridorSlug}`
      : issue.anchorSlug ?? issue.corridorSlug ?? "(unknown)";

  switch (issue.code) {
    case "MISSING_ANCHOR":
      return `- [missing-anchor] "${subject}" is reviewed but not persisted.`;
    case "MISSING_CORRIDOR":
      return `- [missing-corridor] "${subject}" is reviewed but not persisted.`;
    case "UNEXPECTED_ANCHOR":
      return `- [unexpected-anchor] "${subject}" is persisted but not reviewed.`;
    case "UNEXPECTED_CORRIDOR":
      return `- [unexpected-corridor] "${subject}" is persisted but not reviewed.`;
    case "ANCHOR_FIELD_MISMATCH":
    case "CORRIDOR_FIELD_MISMATCH":
      return `- [field-mismatch] "${subject}" field ${issue.field}: ` +
        `reviewed "${issue.expected}" vs persisted "${issue.actual}".`;
    case "MISSING_ASSOCIATION":
      return `- [missing-association] reviewed membership "${subject}" is not persisted.`;
    case "UNEXPECTED_ASSOCIATION":
      return `- [unexpected-association] persisted membership "${subject}" is not reviewed.`;
    case "ORPHANED_ANCHOR_LINK":
    case "ORPHANED_CORRIDOR_LINK":
      return `- [orphaned-link] membership "${subject}" points at a ` +
        `registry-unlisted row.`;
    case "ORPHANED_RATE_SNAPSHOT":
      return `- [orphaned-rate-snapshot] "${subject}" holds ` +
        `${issue.historicalEvidenceCount ?? 0} rate snapshot(s) outside the reviewed registry.`;
    case "ORPHANED_TRANSFER_OUTCOME":
      return `- [orphaned-transfer-outcome] "${subject}" holds ` +
        `${issue.historicalEvidenceCount ?? 0} transfer outcome(s) outside the reviewed registry.`;
    case "STALE_ANCHOR":
    case "STALE_CORRIDOR":
      return `- [stale] "${subject}" carries ${issue.historicalEvidenceCount ?? 0} ` +
        `historical evidence row(s); retirement requires manual review.`;
    default:
      return `- [${issue.code}] "${subject}".`;
  }
}

function appendRepairPlan(
  lines: string[],
  plan: RegistryRepairPlan,
): void {
  lines.push("");
  lines.push("Proposed repair plan (not applied)");
  lines.push("----------------------------------");

  if (
    plan.safeActions.length === 0 &&
    plan.manualReviewActions.length === 0 &&
    plan.skippedEvidenceDeletions.length === 0
  ) {
    lines.push("(no actions required)");
    return;
  }

  if (plan.safeActions.length > 0) {
    lines.push("Safe (evidence-independent, deterministic upserts):");
    for (const action of plan.safeActions) {
      lines.push(`  - ${formatAction(action)}`);
    }
  }

  if (plan.manualReviewActions.length > 0) {
    lines.push("Requires explicit maintainer review:");
    for (const action of plan.manualReviewActions) {
      lines.push(`  - ${formatAction(action)}`);
    }
  }

  if (plan.skippedEvidenceDeletions.length > 0) {
    lines.push("Refused automatically (historical evidence would be destroyed):");
    for (const action of plan.skippedEvidenceDeletions) {
      lines.push(`  - ${formatAction(action)}`);
    }
  }

  lines.push(
    plan.appliesWithoutManualAction
      ? "The safe plan can be applied without manual action."
      : "This plan is NOT applied. A maintainer must review the flagged actions.",
  );
}

function formatAction(
  action: RegistryRepairPlan["safeActions"][number],
): string {
  const subject =
    action.anchorSlug && action.corridorSlug
      ? `${action.anchorSlug} <-> ${action.corridorSlug}`
      : action.anchorSlug ?? action.corridorSlug ?? "(unknown)";
  const field = action.field ? ` field ${action.field}` : "";
  const value = action.expected !== undefined ? ` -> "${action.expected}"` : "";
  const evidence = action.historicalEvidenceCount !== undefined
    ? ` (historical evidence rows: ${action.historicalEvidenceCount})`
    : "";

  return `${action.kind} ${action.entity} "${subject}"${field}${value}${evidence}`;
}
