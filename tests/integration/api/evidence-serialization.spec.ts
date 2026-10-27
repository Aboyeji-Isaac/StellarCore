import { test, expect } from '@playwright/test';

// Documented public contract
const PUBLIC_EVIDENCE_FIELDS = [
  'id', 
  'publicIdentifier', 
  'title', 
  'status', 
  'createdAt', 
  'updatedAt'
];

test.describe('Public Evidence Serialization', () => {
  test('public responses strictly omit internal database identifiers and metadata', async ({ request }) => {
    const res = await request.get('/api/evidence/public/latest');
    expect(res.ok()).toBeTruthy();
    
    const { data } = await res.json();
    expect(data.length).toBeGreaterThan(0);
    
    const record = data[0];
    const keys = Object.keys(record);
    
    // Fail if a new internal field is added without updating the public contract
    keys.forEach(key => {
      expect(PUBLIC_EVIDENCE_FIELDS).toContain(key);
    });
    
    // Explicit regression checks for specific internal structures
    expect(record).not.toHaveProperty('_id');
    expect(record).not.toHaveProperty('databaseId');
    expect(record).not.toHaveProperty('diagnosticMetadata');
    expect(record).not.toHaveProperty('issuerCredentials');
    
    // Intended stable public identifier remains available
    expect(record.publicIdentifier).toBeDefined();
  });
});