# Browser security headers and CSP

StellarCore applies a request-scoped Content Security Policy to browser-rendered
App Router pages.

## Production policy

Each page request receives a fresh cryptographically random nonce. Middleware
forwards the nonce and CSP through upstream request headers so Next.js can apply
the nonce to framework-generated output, then returns the CSP and browser
security headers on the page response.

Production policy includes:

- `default-src 'self'`
- nonce-bound `script-src` with `'strict-dynamic'`
- nonce-bound `style-src`
- no `'unsafe-eval'` or `'unsafe-inline'`
- `object-src 'none'`
- `base-uri 'self'`
- `form-action 'self'`
- `frame-ancestors 'none'`
- `upgrade-insecure-requests`
- HSTS, MIME sniffing protection, referrer policy, permissions policy,
  cross-origin opener/resource policy, and disabled DNS prefetching

The nonce is request-scoped and is not stored in a cookie or emitted as a
standalone response header.

## Development differences

Next.js development tooling requires eval and inline style behavior that the
production application does not. Development therefore adds
`'unsafe-eval'` to `script-src`, `'unsafe-inline'` to `style-src`, and
`ws:`/`wss:` to `connect-src` for hot reload. HSTS and
`upgrade-insecure-requests` are omitted in development.

## API behavior

The middleware matcher excludes `/api/*`, Next.js static/image requests,
prefetches, metadata files, and common static image assets. API responses
therefore do not receive the page-oriented CSP or cross-origin browser policy.

## Runtime and rendering requirement

The middleware explicitly uses the Node.js runtime supported by Next.js 15.5 so
it remains compatible with StellarCore's existing Node-only instrumentation and
configuration-fingerprint dependency graph.

Nonce-based CSP requires dynamic request-time rendering. The root App Router
layout reads request headers so Next.js has the request context required to
nonce its framework output.

## Verification

The dedicated CSP workflow:

1. runs policy and middleware unit tests;
2. runs lint and a production `next build`;
3. starts the built application;
4. requests the home page twice and verifies different nonces;
5. checks that the CSP nonce is present on rendered script tags;
6. checks hardened response headers; and
7. requests an `/api/*` path and verifies that the browser CSP is absent.
