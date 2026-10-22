import { describe, it, expect } from 'vitest';
import { serializeProvenance } from '@/lib/serializers/rate-provenance';

describe('Credential-Free Rate-Provenance Serialization', () => {
  const rawInternalProvenance = {
    id: 'prov_123',
    sourceUrl: 'https://api.stellar.org/rates',
    fetchedAt: '2023-10-01T12:00:00Z',
    _internalDbId: 999,
    authHeader: 'Bearer secret-token',
    connectionPassword: 'db-password'
  };

  it('serializes safe identifiers and expected fields', () => {
    const result = serializeProvenance(rawInternalProvenance);
    
    expect(result).toEqual({
      id: 'prov_123',
      sourceUrl: 'https://api.stellar.org/rates',
      fetchedAt: '2023-10-01T12:00:00Z'
    });
  });

  it('completely omits credentials, authorization values, and secret-bearing fields', () => {
    const result = serializeProvenance(rawInternalProvenance);
    
    expect(result).not.toHaveProperty('authHeader');
    expect(result).not.toHaveProperty('connectionPassword');
    expect(result).not.toHaveProperty('_internalDbId');
  });

  it('fails safely if unexpected internal fields are added', () => {
    // Tests that the serializer operates on an explicit allowlist, not a denylist.
    const mutatedProvenance = { ...rawInternalProvenance, newSecretField: 'hidden' };
    const result = serializeProvenance(mutatedProvenance);
    
    expect(result).not.toHaveProperty('newSecretField');
  });
});