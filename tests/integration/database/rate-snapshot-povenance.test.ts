import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from '@/lib/db'; // Adjust import to your DB client

describe('Rate-Snapshot Provenance Integrity', () => {
  beforeEach(async () => {
    await prisma.rateSnapshot.deleteMany();
    await prisma.rateProvenance.deleteMany();
  });

  afterEach(async () => {
    await prisma.rateSnapshot.deleteMany();
    await prisma.rateProvenance.deleteMany();
  });

  it('resolves a persisted snapshot to the correct provenance record', async () => {
    const provenance = await prisma.rateProvenance.create({
      data: { source: 'horizon', timestamp: new Date() }
    });

    const snapshot = await prisma.rateSnapshot.create({
      data: { rate: 1.5, provenanceId: provenance.id }
    });

    const retrieved = await prisma.rateSnapshot.findUnique({
      where: { id: snapshot.id },
      include: { provenance: true }
    });

    expect(retrieved?.provenance?.id).toBe(provenance.id);
  });

  it('rejects invalid or missing references at the schema boundary', async () => {
    await expect(
      prisma.rateSnapshot.create({
        data: { rate: 1.5, provenanceId: 'non-existent-id' }
      })
    ).rejects.toThrow(/Foreign key constraint failed/i);
  });

  it('allows legacy snapshots without available provenance', async () => {
    const legacySnapshot = await prisma.rateSnapshot.create({
      data: { rate: 1.5, provenanceId: null } // Assuming schema allows nullable for legacy
    });
    
    expect(legacySnapshot.id).toBeDefined();
  });
});