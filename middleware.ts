import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  buildBrowserSecurityHeaders,
  CSP_HEADER,
  CSP_NONCE_HEADER,
  generateCspNonce,
} from "@/lib/security/browserHeaders";
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
} from "@/lib/security/requestId";

export function middleware(request: NextRequest): NextResponse {
  const incomingId = request.headers.get(REQUEST_ID_HEADER);
  const requestId = resolveRequestId(incomingId);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(REQUEST_ID_HEADER, requestId);

  const pathname = request.nextUrl?.pathname ?? new URL(request.url).pathname;
  const isApi = pathname.startsWith("/api");

  if (isApi) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders,
      },
    });
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return response;
  }

  const isDevelopment = process.env.NODE_ENV === "development";
  const nonce = generateCspNonce();
  const browserHeaders = buildBrowserSecurityHeaders(nonce, isDevelopment);

  requestHeaders.set(CSP_NONCE_HEADER, nonce);
  requestHeaders.set(CSP_HEADER, browserHeaders[CSP_HEADER]!);

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  });

  response.headers.set(REQUEST_ID_HEADER, requestId);
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
        "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico)$).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
