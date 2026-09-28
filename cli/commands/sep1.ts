import { prisma } from '../../lib/prisma';
import { computeMetadataDigest } from '../../lib/stellar/sep1';

export async function approveObservation(
  anchorId: string,
  observationId: string,
  approvedFields: Record<string, any>,
  approvedBy: string,
  reason: string
): Promise<void> {
  const observation = await prisma.sep1DiscoveryObservation.findUnique({
    where: { id: observationId }
  });

  if (!observation) throw new Error('Observation not found');

  const digest = computeMetadataDigest(approvedFields);
  if (digest !== observation.digest) {
    throw new Error('Approved fields do not match observation digest');
  }

  await prisma.sep1ApprovedBaseline.create({
    data: {
      anchorId,
      observationId,
      approvedFields,
      approvedAt: new Date(),
      approvedBy,
      reason
    }
  });
}

export async function rejectObservation(
  anchorId: string,
  observationId: string,
  reason: string
): Promise<void> {
  await prisma.sep1ApprovedBaseline.create({
    data: {
      anchorId,
      observationId,
      approvedFields: null,
      approvedAt: new Date(),
      approvedBy: 'system',
      reason: `Rejected: ${reason}`
    }
  });
}