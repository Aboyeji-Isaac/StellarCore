import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

const getArgValue = (argName: string, defaultValue: number) => {
  const arg = args.find((a) => a.startsWith(`--${argName}=`));
  if (arg) {
    return parseInt(arg.split("=")[1], 10);
  }
  return defaultValue;
};

const ratesDays = getArgValue("days-rates", 7);
const outcomesDays = getArgValue("days-outcomes", 97);

async function main() {
  const db = new PrismaClient();
  try {
    console.log(`Starting archival process...`);
    console.log(`Dry run: ${isDryRun}`);
    console.log(`Rates older than ${ratesDays} days`);
    console.log(`Outcomes older than ${outcomesDays} days`);

    // --- Archiving RateSnapshots ---
    const ratesCutoff = new Date();
    ratesCutoff.setDate(ratesCutoff.getDate() - ratesDays);

    const protectedRates = await db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (anchor_id, corridor_id) id
      FROM rate_snapshots
      ORDER BY anchor_id, corridor_id, captured_at DESC, id DESC
    `;
    const protectedRateIds = protectedRates.map((r) => r.id);
    console.log(`Protected ${protectedRateIds.length} latest rate snapshots from archival.`);

    let archivedRatesCount = 0;
    while (true) {
      const batch = await db.rateSnapshot.findMany({
        where: {
          capturedAt: { lt: ratesCutoff },
          id: { notIn: protectedRateIds },
        },
        take: 1000,
        orderBy: { id: "asc" },
      });

      if (batch.length === 0) break;

      if (!isDryRun) {
        await db.$transaction(async (tx) => {
          await tx.archivedRateSnapshot.createMany({
            data: batch.map((r) => ({
              id: r.id,
              anchorId: r.anchorId,
              corridorId: r.corridorId,
              rate: r.rate,
              sourceAmount: r.sourceAmount,
              destinationAmount: r.destinationAmount,
              fee: r.fee,
              capturedAt: r.capturedAt,
              archivedAt: new Date(),
            })),
            skipDuplicates: true,
          });
          await tx.rateSnapshot.deleteMany({
            where: { id: { in: batch.map((r) => r.id) } },
          });
        });
      }
      archivedRatesCount += batch.length;
      console.log(`Processed batch of ${batch.length} rate snapshots. Total: ${archivedRatesCount}`);
    }

    // --- Archiving TransferOutcomes ---
    const outcomesCutoff = new Date();
    outcomesCutoff.setDate(outcomesCutoff.getDate() - outcomesDays);

    let archivedOutcomesCount = 0;
    while (true) {
      const batch = await db.transferOutcome.findMany({
        where: {
          recordedAt: { lt: outcomesCutoff },
        },
        take: 1000,
        orderBy: { id: "asc" },
      });

      if (batch.length === 0) break;

      if (!isDryRun) {
        await db.$transaction(async (tx) => {
          await tx.archivedTransferOutcome.createMany({
            data: batch.map((r) => ({
              id: r.id,
              anchorId: r.anchorId,
              corridorId: r.corridorId,
              status: r.status,
              fillRate: r.fillRate,
              settlementMs: r.settlementMs,
              slippage: r.slippage,
              recordedAt: r.recordedAt,
              archivedAt: new Date(),
            })),
            skipDuplicates: true,
          });
          await tx.transferOutcome.deleteMany({
            where: { id: { in: batch.map((r) => r.id) } },
          });
        });
      }
      archivedOutcomesCount += batch.length;
      console.log(`Processed batch of ${batch.length} transfer outcomes. Total: ${archivedOutcomesCount}`);
    }

    console.log(`Archival complete.`);
    console.log(`Archived ${archivedRatesCount} rate snapshots.`);
    console.log(`Archived ${archivedOutcomesCount} transfer outcomes.`);
  } catch (error) {
    console.error("Error archiving evidence:", error);
    process.exit(1);
  } finally {
    await db.$disconnect();
  }
}

main();
