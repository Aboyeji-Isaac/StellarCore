import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

async function main() {
  const db = new PrismaClient();
  try {
    console.log(`Starting restore process...`);
    console.log(`Dry run: ${isDryRun}`);

    // --- Restoring RateSnapshots ---
    let restoredRatesCount = 0;
    while (true) {
      const batch = await db.archivedRateSnapshot.findMany({
        take: 1000,
        orderBy: { id: "asc" },
      });

      if (batch.length === 0) break;

      if (!isDryRun) {
        await db.$transaction(async (tx) => {
          await tx.rateSnapshot.createMany({
            data: batch.map((r) => ({
              id: r.id,
              anchorId: r.anchorId,
              corridorId: r.corridorId,
              rate: r.rate,
              sourceAmount: r.sourceAmount,
              destinationAmount: r.destinationAmount,
              fee: r.fee,
              capturedAt: r.capturedAt,
            })),
            skipDuplicates: true,
          });
          await tx.archivedRateSnapshot.deleteMany({
            where: { id: { in: batch.map((r) => r.id) } },
          });
        });
      }
      restoredRatesCount += batch.length;
      console.log(`Processed batch of ${batch.length} archived rate snapshots. Total: ${restoredRatesCount}`);
    }

    // --- Restoring TransferOutcomes ---
    let restoredOutcomesCount = 0;
    while (true) {
      const batch = await db.archivedTransferOutcome.findMany({
        take: 1000,
        orderBy: { id: "asc" },
      });

      if (batch.length === 0) break;

      if (!isDryRun) {
        await db.$transaction(async (tx) => {
          await tx.transferOutcome.createMany({
            data: batch.map((r) => ({
              id: r.id,
              anchorId: r.anchorId,
              corridorId: r.corridorId,
              status: r.status,
              fillRate: r.fillRate,
              settlementMs: r.settlementMs,
              slippage: r.slippage,
              recordedAt: r.recordedAt,
            })),
            skipDuplicates: true,
          });
          await tx.archivedTransferOutcome.deleteMany({
            where: { id: { in: batch.map((r) => r.id) } },
          });
        });
      }
      restoredOutcomesCount += batch.length;
      console.log(`Processed batch of ${batch.length} archived transfer outcomes. Total: ${restoredOutcomesCount}`);
    }

    console.log(`Restore complete.`);
    console.log(`Restored ${restoredRatesCount} rate snapshots.`);
    console.log(`Restored ${restoredOutcomesCount} transfer outcomes.`);
  } catch (error) {
    console.error("Error restoring evidence:", error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
