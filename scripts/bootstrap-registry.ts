import "dotenv/config";

import { pathToFileURL } from "node:url";

import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import { createStructuredLogger } from "@/lib/scheduled/structuredLog";
import { syncAnchorRegistry } from "@/lib/stellar/anchorSync";
import { syncCorridorRegistry } from "@/lib/stellar/corridorSync";

const logger = createStructuredLogger("bootstrap-registry");

async function main(): Promise<void> {
  assertCurrentStellarCoreConfiguration();
  const { db, ensureDatabaseEnvironment } = await import("@/lib/dbClient");

  try {
    // Environment isolation (#143): bootstrap mutates registry/evidence data,
    // so it refuses to run unless the runtime and database identities match.
    // The check runs before any synchronization work.
    await ensureDatabaseEnvironment();
    const anchors = await syncAnchorRegistry();
    const corridors = await syncCorridorRegistry();

    logger.info("Reviewed registry synchronization completed", {
      summary: { anchors, corridors },
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
