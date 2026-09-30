import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const CSP_NONCE_HEADER = "x-csp-nonce";
const CSP_HEADER = "Content-Security-Policy";

export function generateNonce(): string {
  const array = new Uint8Array(16);
  crypto.getRandomValues(array);
  return Buffer.from(array).toString("base64");
}

export function buildCspPolicy(nonce: string, isDevelopment: boolean): string {
  const scriptSrc = [
    "'self'",
    "'strict-dynamic'",
    `'nonce-${nonce}'`,
    isDevelopment ? "'unsafe-eval'" : "",
  ].filter(Boolean).join(" ");

  const styleSrc = [
    "'self'",
    `'nonce-${nonce}'`,
  ].join(" ");

  const imgSrc = [
    "'self'",
    "data:",
    "blob:",
  ].join(" ");

  const fontSrc = [
    "'self'",
    "data:",
  ].join(" ");

  const connectSrc = [
    "'self'",
  ].join(" ");

  const frameAncestors = "'none'";

  const baseUri = "'self'";

  const formAction = "'self'";

  const objectSrc = "'none'";

  const upgradeInsecureRequests = !isDevelopment ? "upgrade-insecure-requests" : "";

  const policy = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `font-src ${fontSrc}`,
    `connect-src ${connectSrc}`,
    `frame-ancestors ${frameAncestors}`,
    `base-uri ${baseUri}`,
    `form-action ${formAction}`,
    `object-src ${objectSrc}`,
    upgradeInsecureRequests,
    "block-all-mixed-content",
  ].filter(Boolean).join("; ");

  return policy;
}

export function buildSecurityHeaders(nonce: string, isDevelopment: boolean): Record<string, string> {
  const csp = buildCspPolicy(nonce, isDevelopment);

  return {
    [CSP_HEADER]: csp,
    [CSP_NONCE_HEADER]: nonce,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": [
      "accelerometer=()",
      "camera=()",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "payment=()",
      "usb=()",
      "interest-cohort=()",
    ].join(", "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "on",
    "X-Permitted-Cross-Domain-Policies": "none",
  };
}

export function isApiRoute(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const isDevelopment = process.env.NODE_ENV === "development";

  const response = NextResponse.next();

  const securityHeaders = buildSecurityHeaders(nonce, isDevelopment);

  for (const [key, value] of Object.entries(securityHeaders)) {
    response.headers.set(key, value);
  }

  if (!isApiRoute(request.nextUrl.pathname)) {
    response.cookies.set("csp-nonce", nonce, {
      httpOnly: true,
      secure: !isDevelopment,
      sameSite: "strict",
      path: "/",
      maxAge: 60 * 60,
    });
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.png$).*)",
  ],
};