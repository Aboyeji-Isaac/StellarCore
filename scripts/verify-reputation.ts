import "dotenv/config";

import { db } from "@/lib/dbClient";
import { evaluateAnchorReputation } from "@/lib/reputation/engine";

const ANCHOR_SLUGS = Object.freeze(["cowrie", "moneygram", "zeam"]);

async function main(): Promise<void> {
  const evaluatedAt = new Date();
  const before = await db.reputationScore.count();
  const results = [];
  for (const slug of ANCHOR_SLUGS) {
    results.push(await evaluateAnchorReputation(slug, { evaluatedAt }));
  }
  const after = await db.reputationScore.count();

  console.log(JSON.stringify({
    evaluatedAt: evaluatedAt.toISOString(),
    reputationScoreCount: { before, after },
    results,
  }, null, 2));
}

main()
  .catch(() => {
    console.error(JSON.stringify({ ok: false, code: "VERIFICATION_FAILURE" }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
