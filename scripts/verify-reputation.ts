import "dotenv/config";

import { db } from "@/lib/dbClient";
import { evaluatePersistedAnchorReputations } from "@/lib/reputation/run";
import { createStructuredLogger } from "@/lib/scheduled/structuredLog";

const ANCHOR_SLUGS = Object.freeze(["cowrie", "moneygram", "zeam"]);

const logger = createStructuredLogger("verify-reputation");

async function main(): Promise<void> {
  const evaluatedAt = new Date();
  const before = await db.reputationScore.count();
  const result = await evaluatePersistedAnchorReputations({
    anchorSlugs: ANCHOR_SLUGS,
    evaluatedAt,
  });
  const after = await db.reputationScore.count();

  logger.info("Reputation evaluation completed", {
    anchorSlugs: ANCHOR_SLUGS,
    summary: {
      evaluatedAt: evaluatedAt.toISOString(),
      reputationScoreCount: { before, after },
      result,
    },
  });
}

main()
  .catch(() => {
    logger.error("Reputation evaluation failed", { code: "VERIFICATION_FAILURE" });
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
