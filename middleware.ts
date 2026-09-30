import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateCSPHeader, generateSecurityHeaders } from './lib/securityHeaders';

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID();
  const cspHeader = generateCSPHeader(nonce);
  const securityHeaders = generateSecurityHeaders(cspHeader);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  Object.entries(securityHeaders).forEach(([key, value]) => {
    response.headers.set(key, value);
  });

  return response;
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
