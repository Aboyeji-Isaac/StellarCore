import { createHash } from 'crypto';
import { Anchor, SEP1DiscoveryResult } from './types';

// Canonicalization rules (versioned)
const CANONICALIZE_RULES = {
  networkPassphrase: (val: string) => val.trim(),
  signingKey: (val: string) => val.toLowerCase().trim(),
  endpoints: (val: Record<string, string>) => {
    const sorted = Object.entries(val).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(sorted);
  },
  assets: (val: any[]) => val.sort((a, b) => a.code.localeCompare(b.code))
};

export function canonicalizeSEP1Metadata(metadata: any): Record<string, any> {
  return {
    networkPassphrase: CANONICALIZE_RULES.networkPassphrase(metadata.network_passphrase),
    signingKey: CANONICALIZE_RULES.signingKey(metadata.signing_key),
    endpoints: CANONICALIZE_RULES.endpoints(metadata.endpoints),
    assets: CANONICALIZE_RULES.assets(metadata.assets)
  };
}

export function computeMetadataDigest(metadata: Record<string, any>): string {
  const canonical = JSON.stringify(metadata, Object.keys(metadata).sort());
  return createHash('sha256').update(canonical).digest('hex');
}

export async function persistDiscoveryObservation(
  anchorId: string,
  result: SEP1DiscoveryResult,
  parserState: string
): Promise<SEP1DiscoveryObservation> {
  const canonical = canonicalizeSEP1Metadata(result.metadata);
  const digest = computeMetadataDigest(canonical);
  return prisma.sep1DiscoveryObservation.create({
    data: {
      anchorId,
      observedAt: new Date(),
      metadata: canonical,
      digest,
      parserState
    }
  });
}

export function isSensitiveField(field: string): boolean {
  return ['networkPassphrase', 'signingKey', 'endpoints', 'assets'].includes(field);
}

export function generateFieldDiff(
  approved: Record<string, any>,
  observed: Record<string, any>
): Record<string, any> {
  const diff: Record<string, any> = {};
  for (const field of Object.keys(observed)) {
    if (isSensitiveField(field) && approved[field] !== observed[field]) {
      diff[field] = { approved: approved[field], observed: observed[field] };
    }
  }
  return diff;
}