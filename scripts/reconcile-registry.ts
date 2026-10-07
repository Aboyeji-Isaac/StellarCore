import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  buildRegistryReconciliationReport,
} from "@/lib/stellar/registryReconciliation";
import {
  formatRegistryReconciliationReport,
} from "@/lib/stellar/registryReconciliationReport";
import {
  PRISMA_REGISTRY_RECONCILIATION_REPOSITORY,
} from "@/lib/stellar/registryReconciliationRepository";
import {
  ANCHOR_REGISTRY,
} from "@/constants/anchors";
import {
  ANCHOR_CORRIDOR_REGISTRY,
  CORRIDOR_REGISTRY,
} from "@/constants/corridors";

/**
 * Read-only registry-to-database reconciliation auditor.
 *
 * Compares the reviewed source-controlled registries with the persisted
 * anchor/corridor configuration, classifies drift, and prints a proposed
 * repair plan. It never writes: the repository adapter performs reads only,
 * and plans are output only. Exit code 1 signals drift or a load failure so
 * maintainers and CI can gate on reconciliation without any mutation risk.
 */
async function main(): Promise<void> {
  try {
    const persisted =
      await PRISMA_REGISTRY_RECONCILIATION_REPOSITORY.loadPersistedState();

    const report = buildRegistryReconciliationReport({
      anchors: ANCHOR_REGISTRY,
      corridors: CORRIDOR_REGISTRY,
      anchorCorridorMappings: ANCHOR_CORRIDOR_REGISTRY,
      persisted,
    });

    process.stdout.write(formatRegistryReconciliationReport(report));
    process.stdout.write(
      `${JSON.stringify({
        ok: !report.result.drift,
        drift: report.result.drift,
        summary: report.result.summary,
        historicalEvidence: report.result.historicalEvidence,
        plan: {
          safeActionCount: report.plan.safeActions.length,
          manualReviewActionCount: report.plan.manualReviewActions.length,
          skippedEvidenceDeletionCount:
            report.plan.skippedEvidenceDeletions.length,
          appliesWithoutManualAction: report.plan.appliesWithoutManualAction,
        },
      }, null, 2)}\n`,
    );

    if (report.result.drift) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      drift: null,
      code: "RECONCILIATION_READ_FAILURE",
    })}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().finally(async () => {
    const { db } = await import("@/lib/dbClient");
    await db.$disconnect();
  });
}
