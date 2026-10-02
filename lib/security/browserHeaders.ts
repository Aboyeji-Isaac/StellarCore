export const CSP_NONCE_HEADER = "x-nonce";
export const CSP_HEADER = "Content-Security-Policy";

export function generateCspNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function buildContentSecurityPolicy(
  nonce: string,
  isDevelopment: boolean,
): string {
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ].join(" ");

  const styleSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    ...(isDevelopment ? ["'unsafe-inline'"] : []),
  ].join(" ");

  const connectSrc = isDevelopment
    ? "'self' ws: wss:"
    : "'self'";

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDevelopment ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function buildBrowserSecurityHeaders(
  nonce: string,
  isDevelopment: boolean,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [CSP_HEADER]: buildContentSecurityPolicy(nonce, isDevelopment),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
    "X-Permitted-Cross-Domain-Policies": "none",
    ...(isDevelopment
      ? {}
      : {
          "Strict-Transport-Security":
            "max-age=63072000; includeSubDomains; preload",
        }),
  });
}
