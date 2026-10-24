import { describe, it, expect } from 'vitest';
import { canonicalizeSepUrl } from '@/lib/utils/sep-url';

describe('SEP URL Canonicalization', () => {
  it('normalizes equivalent safe URLs to the same canonical value', () => {
    const expected = 'https://example.com/sep-target';
    
    expect(canonicalizeSepUrl('https://example.com:443/sep-target')).toBe(expected);
    expect(canonicalizeSepUrl('https://example.com/sep-target/')).toBe(expected);
    expect(canonicalizeSepUrl('HTTPS://EXAMPLE.COM/sep-target')).toBe(expected);
    expect(canonicalizeSepUrl('https://example.com/sep-target#fragment')).toBe(expected);
  });

  it('rejects unsafe schemes', () => {
    expect(() => canonicalizeSepUrl('http://example.com/sep')).toThrow('Unsafe scheme');
    expect(() => canonicalizeSepUrl('ftp://example.com/sep')).toThrow('Unsafe scheme');
  });

  it('rejects credential-bearing URLs', () => {
    expect(() => canonicalizeSepUrl('https://user:pass@example.com/sep')).toThrow('Credentials not allowed in SEP URLs');
  });
});