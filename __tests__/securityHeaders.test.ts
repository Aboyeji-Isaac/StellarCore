import { NextRequest, NextResponse } from 'next/server';
import { middleware } from '../middleware';
import { generateCSPHeader, generateSecurityHeaders } from '../lib/securityHeaders';

describe('Security Headers', () => {
  describe('CSP Generation', () => {
    it('should generate a valid CSP with nonce', () => {
      const nonce = 'test-nonce-123';
      const csp = generateCSPHeader(nonce);

      expect(csp).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
      expect(csp).toContain("style-src 'self' 'nonce-test-nonce-123' 'unsafe-inline'");
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('should include all required directives', () => {
      const csp = generateCSPHeader('test-nonce');
      const directives = [
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'font-src',
        'connect-src',
        'frame-src',
        'object-src',
        'base-uri',
        'form-action',
        'frame-ancestors',
        'upgrade-insecure-requests',
      ];

      directives.forEach((dir) => {
        expect(csp).toContain(`${dir} `);
      });
    });
  });

  describe('Security Headers Generation', () => {
    it('should include all security headers', () => {
      const csp = generateCSPHeader('test-nonce');
      const headers = generateSecurityHeaders(csp);

      expect(headers['Content-Security-Policy']).toBe(csp);
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['X-XSS-Protection']).toBe('1; mode=block');
      expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
      expect(headers['Permissions-Policy']).toBe('geolocation=(), microphone=(), camera=()');
      expect(headers['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains; preload');
    });
  });

  describe('Middleware', () => {
    it('should add security headers to response', () => {
      const request = new NextRequest('http://localhost:3000', {
        headers: new Headers(),
      });

      const response = middleware(request);

      expect(response.headers.get('Content-Security-Policy')).toContain('script-src');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('x-nonce')).toBeTruthy();
    });

    it('should not add headers to API routes', () => {
      const apiRequest = new NextRequest('http://localhost:3000/api/test', {
        headers: new Headers(),
      });

      const response = middleware(apiRequest);

      expect(response.headers.get('Content-Security-Policy')).toBeNull();
    });
  });
});
