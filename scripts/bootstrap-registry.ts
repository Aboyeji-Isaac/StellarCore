import "dotenv/config";

import { pathToFileURL } from "node:url";

import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import { createStructuredLogger } from "@/lib/scheduled/structuredLog";
import { syncAnchorRegistry } from "@/lib/stellar/anchorSync";
import { syncCorridorRegistry } from "@/lib/stellar/corridorSync";

const logger = createStructuredLogger("bootstrap-registry");

async function main(): Promise<void> {
  assertCurrentStellarCoreConfiguration();
  const { db } = await import("@/lib/dbClient");

  try {
    const anchors = await syncAnchorRegistry();
    const corridors = await syncCorridorRegistry();

    logger.info("Reviewed registry synchronization completed", {
      summary: {
        anchors: {
          totalAttempted: anchors.totalAttempted,
          succeeded: anchors.succeeded,
          failed: anchors.failed,
          successfulSlugs: anchors.successfulSlugs,
          failures: anchors.failures,
        },
        corridors: {
          totalCorridorsAttempted: corridors.totalCorridorsAttempted,
          corridorsSynchronized: corridors.corridorsSynchronized,
          totalAssociations: corridors.totalAssociations,
          successfulCorridorSlugs: corridors.successfulCorridorSlugs,
          failures: corridors.failures,
        },
      },
    });

    if (anchors.failed > 0 || corridors.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main()
    .catch(() => {
      logger.error("Reviewed registry synchronization failed", {
        code: "BOOTSTRAP_FAILURE",
      });
      process.exitCode = 1;
    });
}
