# Public API request budgets

Public read endpoints (`/api/anchors`, `/api/corridors`, `/api/rates`,
`/api/reputation`, and their `[slug]` routes) are budgeted per client by
`middleware.ts` before any route or database work runs. `/api/internal/*`
(scheduled refresh) is excluded by the middleware matcher and by an in-code
guard; it keeps its own `CRON_SECRET` authorization and is never throttled by
this policy. The server-rendered dashboard reads persisted data directly and is
not covered by this limiter.

## Budgets

Fixed 60-second windows, per client and per route group:

| Group | Paths | Default | Override |
|---|---|---:|---|
| catalog | anchors, corridors, unknown `/api/*` | 120 / min | `RATE_LIMIT_CATALOG_PER_MINUTE` |
| rates | rates | 60 / min | `RATE_LIMIT_RATES_PER_MINUTE` |
| reputation | reputation | 60 / min | `RATE_LIMIT_REPUTATION_PER_MINUTE` |

Burst behavior: the whole window budget may be spent at once. Fixed windows
allow up to 2x the budget across a window boundary (end of one window plus
start of the next). Invalid override values are ignored and defaults apply.

## Over-budget response

HTTP 429, `Cache-Control: no-store`, `Retry-After: <seconds until the window
ends, 1-60>`:

```json
{"error":{"code":"rate_limited","message":"Too many requests. Retry later.","retryAfterSeconds":42}}
```

Admitted requests are untouched: same payloads, status codes and headers.

## Shared storage

Counters live in a Redis-compatible store reached over its REST API (for
example Upstash or Vercel KV) with one pipelined `INCR` + `PEXPIRE`, so counts
are shared across all serverless instances. The code depends only on the
`RateLimitStore` interface (`lib/ratelimit/store.ts`), not on a vendor SDK.

Keys: `rl:v1:<group>:<16-hex client hash>:<window index>`, expiring after two
windows (bounded retention). The client hash is a truncated HMAC-SHA-256 of the
resolved identity keyed with `RATE_LIMIT_KEY_SECRET`; raw IP addresses are never
stored or logged.

## Client identity trust boundary

Only one header is trusted: `RATE_LIMIT_TRUSTED_IP_HEADER` (default
`x-vercel-forwarded-for`, set by the Vercel edge and not client-controllable).
`x-forwarded-for`, `x-real-ip` and `forwarded` are never read. The last list
entry is used, IPv4 must be canonical, IPv6 is bucketed by /64, and a missing
or malformed value maps to one shared `unknown` identity. Spoofed values
therefore cannot create additional budgets. If deployed behind a different
proxy, set the header that proxy overwrites; otherwise all traffic shares the
`unknown` budget (safe, but coarse).

## Backend failure policy

The public routes are read-only and never write evidence, so a limiter outage
cannot corrupt or fabricate data. On store errors, timeouts (300 ms) or invalid
replies each route group uses `local_fallback`: a per-instance counter with the
same budget keeps abuse bounded, and the API stays available. This is degraded
(not shared) protection. Failing closed would turn a limiter outage into a full
API outage. A `deny` mode (HTTP 503, `rate_limiter_unavailable`, `Retry-After: 5`)
exists per policy for routes that later need it. Unexpected internal limiter
errors fail open. The limiter never depends on the database.

## Configuration

| Variable | Purpose |
|---|---|
| `RATE_LIMIT_REDIS_REST_URL` | HTTPS URL of the Redis REST endpoint (required for shared production enforcement) |
| `RATE_LIMIT_REDIS_REST_TOKEN` | Server-only bearer token for that endpoint |
| `RATE_LIMIT_KEY_SECRET` | 16+ character secret keying the client hash |
| `RATE_LIMIT_TRUSTED_IP_HEADER` | Platform-controlled client IP header |
| `RATE_LIMIT_*_PER_MINUTE` | Per-group budget overrides |

If no store is configured, the process-local memory store is used. That is
intended for local development, tests and previews only and is NOT shared
across instances; production logs a one-time warning when this happens.

## Local behavior and tests

Without a store and without the trusted header, every local request shares one
`unknown` bucket. Tests use the in-memory store with an injected clock and a
shared store between two limiter instances to prove counters are not
process-local: `npm test -- tests/unit/ratelimit`.
