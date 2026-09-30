# Security Headers and Content Security Policy

## Overview
This document describes the security headers and Content Security Policy (CSP) implemented in StellarCore to protect against common web vulnerabilities.

## Content Security Policy (CSP)
The application uses a nonce-based CSP to allow dynamic script and style execution while maintaining strict security controls.

### Production CSP Directives
- `default-src 'self'` - Default restriction to same-origin
- `script-src 'self' 'nonce-{nonce}' 'strict-dynamic'` - Allows scripts with valid nonce and strict dynamic loading
- `style-src 'self' 'nonce-{nonce}' 'unsafe-inline'` - Allows styles with nonce (unsafe-inline required for Next.js CSS-in-JS)
- `img-src 'self' data: blob: https:` - Allows images from self, data URIs, blobs, and HTTPS
- `font-src 'self'` - Restricts fonts to same-origin
- `connect-src 'self'` - Restricts fetch/XHR to same-origin
- `frame-src 'none'` - Blocks all iframes
- `object-src 'none'` - Blocks plugins (Flash, etc.)
- `base-uri 'self'` - Restricts base URL to same-origin
- `form-action 'self'` - Restricts form submissions to same-origin
- `frame-ancestors 'none'` - Prevents clickjacking
- `upgrade-insecure-requests` - Upgrades HTTP to HTTPS

### Nonce Generation
A unique nonce is generated for each request and injected into:
1. The CSP header
2. The HTML template via `x-nonce` header
3. Client-side scripts that require dynamic execution

## Security Headers
The following headers are added to all responses:

| Header | Value | Purpose |
|--------|-------|---------|
| Content-Security-Policy | (see above) | Mitigates XSS, data injection |
| X-Content-Type-Options | nosniff | Prevents MIME sniffing |
| X-Frame-Options | DENY | Prevents clickjacking |
| X-XSS-Protection | 1; mode=block | Legacy XSS protection |
| Referrer-Policy | strict-origin-when-cross-origin | Controls referrer information |
| Permissions-Policy | geolocation=(), microphone=(), camera=() | Disables sensor APIs |
| Strict-Transport-Security | max-age=63072000; includeSubDomains; preload | Enforces HTTPS |

## Development Considerations
- The CSP is enforced in both development and production
- Nonces are regenerated for each request in development
- `unsafe-inline` for styles is required for Next.js CSS-in-JS and GSAP
- `strict-dynamic` for scripts allows modern framework behavior without `unsafe-eval`

## Testing
Security headers and CSP are tested in:
- `__tests__/securityHeaders.test.ts` - Unit tests for header generation
- Production verification via `curl -I` and browser dev tools
- Regression tests for SSR/hydration compatibility

## Exceptions
The following exceptions are made with justification:
1. `style-src 'unsafe-inline'` - Required for Next.js CSS-in-JS and GSAP animations
2. `script-src 'strict-dynamic'` - Allows Next.js dynamic imports without `unsafe-eval`

## Updates
To modify the CSP or security headers:
1. Update the directives in `lib/securityHeaders.ts`
2. Verify all tests pass
3. Test in production staging environment
4. Monitor for console errors related to blocked resources
