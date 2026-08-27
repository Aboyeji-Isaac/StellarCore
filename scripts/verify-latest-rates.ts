import "dotenv/config";

import { db } from "@/lib/dbClient";
import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";

const CORRIDOR_SLUG = "usdc-us-brl-br";

async function main(): Promise<void> {
  const countBefore = await db.rateSnapshot.count();
  const result = await readLatestCorridorRate(CORRIDOR_SLUG, {
    evaluatedAt: new Date(),
  });
  const countAfter = await db.rateSnapshot.count();

  console.log(JSON.stringify({
    countBefore,
    countAfter,
    unchanged: countBefore === countAfter,
    result,
  }, null, 2));
}

main()
  .catch(() => {
    console.error(JSON.stringify({ ok: false, code: "READ_FAILURE" }));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
