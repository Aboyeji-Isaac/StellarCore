import "dotenv/config";

import { pathToFileURL } from "node:url";

import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import { DatabaseConfigurationError } from "@/lib/db/connection";
import { syncAnchorRegistry } from "@/lib/stellar/anchorSync";
import { syncCorridorRegistry } from "@/lib/stellar/corridorSync";

async function main(): Promise<void> {
  assertCurrentStellarCoreConfiguration();
  const { writeDb: db } = await import("@/lib/db/writeClient");

  try {
    const anchors = await syncAnchorRegistry();
    const corridors = await syncCorridorRegistry();

    console.log(JSON.stringify({
      anchors,
      corridors,
    }, null, 2));

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
    .catch((error: unknown) => {
      // Configuration codes are bounded and never include connection strings.
      const code = error instanceof DatabaseConfigurationError
        ? error.code
        : "BOOTSTRAP_FAILURE";
      console.error(JSON.stringify({ ok: false, code }));
      process.exitCode = 1;
    });
}
