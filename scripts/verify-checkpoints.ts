/**
 * CLI: verify evidence checkpoint chains.
 *
 * Usage:
 *   tsx scripts/verify-checkpoints.ts [chain]
 *
 * The script is read-only. It never writes to the database and never
 * contacts the network. Failure output identifies the affected checkpoint
 * range without dumping record values.
 */

import { PrismaClient } from "../app/generated/prisma/client";
import { PrismaPadapterPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";
import { verifyCheckpointChain } from "../lib/evidence/verification";
import { readRateObservations } from "../lib/evidence/readers";

loadEnv();

const DEFAULT_CHAIN = "rate_observation";

async function main(): Promise<number> {
  const chain = process.argv[2] ?? DEFAULT_CHAIN;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    return 2;
  }

  const adapter = new PrismaPadapterPg({ connectionString: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const result = await verifyCheckpointChain({
      prisma,
      chain,
      reader: () => readRateObservations(prisma),
    });
    if (result.ok) {
      console.log(
        `OK chain=${chain} checkpoints=${result.checkpoints} covered=${result.coveredRecords}`,
      );
      return 0;
    }
    console.error(
      `FAIL chain=${chain} checkpoints=${result.checkpoints} covered=${result.coveredRecords}`,
    );
    for (const failure of result.failures) {
      console.error(
        `  - ${failure.kind} checkpoint=${failure.checkpointId} range=${failure.fromId ?? "<empty>"}..${failure.toId ?? "<empty>"}: ${failure.detail}`,
      );
    }
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().then((code) => {
  process.exitCode = code;
});
