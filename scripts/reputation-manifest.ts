import "dotenv/config";

import { db } from "@/lib/dbClient";
import { formatReputationManifestInspection } from "@/lib/reputation/manifest";
import { PRISMA_REPUTATION_MANIFEST_REPOSITORY } from "@/lib/reputation/repository";

/**
 * Internal, read-only inspection of one persisted evidence-set manifest.
 *
 * Usage:
 *   npm run reputation:manifest -- <evaluationId>
 *   npm run reputation:manifest -- --anchor <anchorSlug>
 *
 * Prints a bounded, sanitized projection: stable IDs, enum classifications,
 * timestamps, and counts only. It performs no live SEP call, no recalculation,
 * and no write. A manifest that does not exist (including a legacy evaluation
 * created before manifests existed) prints explicit legacy/unknown lineage
 * rather than inferring membership from current database state.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repository = PRISMA_REPUTATION_MANIFEST_REPOSITORY;

  let record;
  if (args[0] === "--anchor" && args[1]) {
    record = await repository.readLatestManifestForAnchor(args[1]);
  } else if (args[0] && !args[0].startsWith("-")) {
    record = await repository.readManifest(args[0]);
  } else {
    process.stderr.write(
      "usage: npm run reputation:manifest -- <evaluationId> | --anchor <anchorSlug>\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(formatReputationManifestInspection(record));
}

main()
  .catch(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: "INSPECTION_FAILURE" })}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
