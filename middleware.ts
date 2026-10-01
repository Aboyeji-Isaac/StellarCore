import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  buildBrowserSecurityHeaders,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  generateCspNonce,
} from "@/lib/security/browserHeaders";

export function middleware(request: NextRequest): NextResponse {
  const isDevelopment = process.env.NODE_ENV === "development";
  const nonce = generateCspNonce();
  const browserHeaders = buildBrowserSecurityHeaders(nonce, isDevelopment);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, browserHeaders[CSP_HEADER]!);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  for (const [key, value] of Object.entries(browserHeaders)) {
    response.headers.set(key, value);
  }

  return response;
}

export const config = {
  runtime: "nodejs",
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
