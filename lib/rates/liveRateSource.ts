import { prisma } from '../prisma';
import { generateFieldDiff } from '../stellar/sep1';

export async function prepareRateCandidate(anchorId: string): Promise<RateCandidate> {
  const [observation, baseline] = await Promise.all([
    prisma.sep1DiscoveryObservation.findUnique({ where: { anchorId } }),
    prisma.sep1ApprovedBaseline.findUnique({ where: { anchorId } })
  ]);

  if (!observation) throw new Error('No SEP-1 observation available');

  const diff = generateFieldDiff(
    baseline?.approvedFields || {},
    observation.metadata
  );

  if (Object.keys(diff).length > 0) {
    throw new Error(`Sensitive metadata changes detected. Requires review. Diff: ${JSON.stringify(diff)}`);
  }

  return {
    quoteServer: observation.metadata.endpoints.quote,
    // ... other rate candidate logic
  };
}