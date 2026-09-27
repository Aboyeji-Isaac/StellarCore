import "dotenv/config";

import { pathToFileURL } from "node:url";

import {
  loadPersistedAnchorsForProbe,
  probeAnchorsReachability,
} from "@/lib/stellar/reachabilityProbe";

async function main(): Promise<void> {
  const { db } = await import("@/lib/dbClient");

  try {
    const anchors = await loadPersistedAnchorsForProbe();
    const results = await probeAnchorsReachability(anchors);

    console.log(JSON.stringify({
      probedAt: new Date().toISOString(),
      total: results.length,
      reachable: results.filter((result) => result.reachable).length,
      unreachable: results.filter((result) => !result.reachable).length,
      results,
    }, null, 2));

    if (results.some((result) => !result.reachable)) {
      process.exitCode = 1;
    }
  } finally {
    await db.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main()
    .catch((error) => {
      console.error(JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Reachability probe failed",
      }));
      process.exitCode = 1;
    });
}