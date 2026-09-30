export const CSP_DIRECTIVES = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'", "'nonce-{nonce}'", "'strict-dynamic'"],
  styleSrc: ["'self'", "'nonce-{nonce}'", "'unsafe-inline'"],
  imgSrc: ["'self'", "data:", "blob:", "https:"],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  frameSrc: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  upgradeInsecureRequests: [],
} as const;

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
} as const;

export function generateCSPHeader(nonce: string): string {
  const directives = Object.entries(CSP_DIRECTIVES).map(([key, values]) => {
    const resolvedValues = values.map((value) =>
      value.replace('{nonce}', nonce)
    );
    return `${key} ${resolvedValues.join(' ')}`;
  });

  return directives.join('; ');
}

export function generateSecurityHeaders(csp: string): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': csp,
  };
}
