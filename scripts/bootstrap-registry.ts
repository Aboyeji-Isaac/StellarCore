import "dotenv/config";

import { pathToFileURL } from "node:url";

import { assertCurrentStellarCoreConfiguration } from "@/lib/config/currentStellarCoreConfiguration";
import { syncAnchorRegistry } from "@/lib/stellar/anchorSync";
import { syncCorridorRegistry } from "@/lib/stellar/corridorSync";

async function main(): Promise<void> {
  assertCurrentStellarCoreConfiguration();
  const { db } = await import("@/lib/dbClient");

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
    .catch(() => {
      console.error(JSON.stringify({ ok: false, code: "BOOTSTRAP_FAILURE" }));
      process.exitCode = 1;
    });
}
