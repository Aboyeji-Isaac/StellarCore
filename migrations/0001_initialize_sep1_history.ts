import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function markMigrationComplete(anchorId: string): Promise<void> {
  await prisma.sep1MigrationStatus.upsert({
    where: { anchorId },
    create: { anchorId, migrationComplete: true },
    update: { migrationComplete: true }
  });
}

async function main() {
  const anchors = await prisma.anchor.findMany();
  for (const anchor of anchors) {
    await markMigrationComplete(anchor.id);
  }
  console.log('SEP-1 history migration complete');
}

main().catch(console.error);