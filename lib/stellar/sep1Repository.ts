import { prisma } from '../prisma';

export class SEP1Repository {
  async getLatestObservation(anchorId: string): Promise<SEP1DiscoveryObservation | null> {
    return prisma.sep1DiscoveryObservation.findFirst({
      where: { anchorId },
      orderBy: { observedAt: 'desc' }
    });
  }

  async getApprovedBaseline(anchorId: string): Promise<SEP1ApprovedBaseline | null> {
    return prisma.sep1ApprovedBaseline.findFirst({
      where: { anchorId },
      orderBy: { approvedAt: 'desc' }
    });
  }

  async getObservationDiff(anchorId: string): Promise<SEP1FieldDiff> {
    const [observation, baseline] = await Promise.all([
      this.getLatestObservation(anchorId),
      this.getApprovedBaseline(anchorId)
    ]);

    if (!observation || !baseline) return {};
    return generateFieldDiff(baseline.approvedFields, observation.metadata);
  }
}