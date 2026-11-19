# Public API Error and Request-ID Troubleshooting

This guide explains how to read bounded errors from StellarCore's public
read-only JSON API and how to report a failure without exposing sensitive data.
It describes the current `development` behavior verified against the
[error type map](../types/api/errors.ts), [error serializer](../lib/api/errors.ts),
[rate limiter](../lib/api/rateLimiter.ts), and
[error contract tests](../tests/unit/api/errorContract.test.ts).

Examples below are illustrative and derived from serializers and tests; they are
not captured live responses. For route-specific payloads and status codes, use
the [public API reference](api-reference.md). For dashboard panel recovery, use
the [dashboard recovery guide](dashboard-recovery-guide.md).

## Read the bounded error envelope

Completed public JSON error responses use one shape:

```json
{
  "error": {
    "code": "corridor_not_found",
    "message": "Corridor not found."
  }
}
```

Example: an illustrative unknown-corridor response, derived from the shared
serializer.

- `error.code` is the stable, machine-readable value to branch on. It uses
  lowercase snake case and maps to a fixed HTTP status.
- `error.message` is a short, human-readable diagnostic. Display it, but do not
  use it as a control key or parse it for internal detail.
- The top level contains only `error`; `error` contains only `code` and
  `message`. The shared serializer freezes that shape.
- Unexpected exceptions go to a server-side reporter seam. Clients receive a
  generic `internal_error`, not the original exception.

All error responses send `Cache-Control: no-store`. A client-aborted request may
end without a JSON body, so only completed JSON responses are covered by this
envelope.

## Stable error codes and statuses

| HTTP status | Current codes | Consumer action |
| ----------- | ------------- | --------------- |
| 400 | `missing_corridor`, `invalid_corridor`, `invalid_days`, `invalid_corridor_slug`, `invalid_anchor_slug`, `invalid_pagination`, `invalid_query` | Correct the path or query parameters. `invalid_query` is emitted by the rates route for repeated or unsupported query parameters. |
| 404 | `anchor_not_found`, `corridor_not_found` | The slug is valid but has no matching persisted record. Check the reviewed registry and synchronization state before retrying. |
| 429 | `rate_limited` | Reduce request volume and apply bounded backoff. See [Handle a 429 response](#handle-a-429-response). |
| 500 | `internal_error` | Stop retrying in a tight loop. Capture safe diagnostics and report the failure. |
| 503 | `upstream_unavailable` | Reserved in the current status map for bounded dependency failures. Treat it as a transient server-side failure, not as an anchor status. |

The [API reference error table](api-reference.md#conventions) and the
[compatibility contracts](api-compatibility.md) document the stable shape. Do
not treat a message as a guarantee of anchor availability, transfer success, firm
quote availability, or reputation evidence.

## Request IDs and `X-Request-Id`

Current `development` behavior has no application-issued request ID:

- Error bodies do **not** contain `error.requestId`.
- Responses do **not** set `X-Request-Id`.
- Route handlers do not read an inbound `X-Request-Id`, echo it, or use it for
  application-log correlation. Middleware is excluded from `/api` routes.

If your proxy, gateway, or client generates its own opaque ID, keep it in your
own logs and include it in a report with its source clearly labeled. Do not
describe it as a StellarCore request ID. Do not place credentials, URLs, tokens,
email addresses, or other secrets in an ID.

Clients should ignore unrecognized response fields under the documented
[additive compatibility policy](api-compatibility.md).
Do not assume that a field named `requestId` is an authorization value or a
trusted internal identifier.

## Keep diagnostics sanitized

Client-visible messages are static and bounded. The serializers do not return
stack traces, ORM or database messages, raw upstream responses, credentials,
JWTs, private endpoint details, or environment values. The
[unknown-exception regression test](../tests/unit/api/errorContract.test.ts)
checks that representative secret-like strings never reach the client body.

Server-side logs are a different boundary. The default reporter passes the
underlying error to `console.error`, so raw operator logs may contain sensitive
text. Never paste raw logs into a public issue. Redact at least:

- `DATABASE_URL`, `CRON_SECRET`, API keys, and private keys;
- `Authorization` headers, bearer tokens, JWTs, cookies, and SEP-10 artifacts;
- full client IP addresses and forwarded-for chains;
- customer data, internal hostnames, and raw exception or SQL text.

Example: a sanitized report payload with placeholders.

```json
{
  "utcTime": "2026-11-19T12:34:56.000Z",
  "method": "GET",
  "path": "/api/rates",
  "query": "corridor=<reviewed-public-slug>",
  "status": 500,
  "code": "internal_error",
  "message": "Unable to read rates.",
  "deployment": "<non-secret-label>",
  "proxyCorrelationId": "<optional-gateway-id>"
}
```

Omit `proxyCorrelationId` if no proxy or client produced one.

## Handle a 429 response

The public GET routes share an in-memory fixed-window limiter: 100 requests per
minute per client identity, per server process. Client identity is the first
`x-forwarded-for` entry, then `x-real-ip`, then the constant `anonymous`. The
window is 60 seconds, and the internal cron route is exempt. See
[Rate limiting](api-reference.md#rate-limiting) and the
[limiter implementation](../lib/api/rateLimiter.ts).

Example: an illustrative rate-limit response derived from the limiter.

```json
{
  "error": {
    "code": "rate_limited",
    "message": "Too many requests. Please try again later."
  }
}
```

The current 429 response sets `Cache-Control: no-store` but does **not** set
`Retry-After` or `X-RateLimit-*` headers. If an external gateway adds a
`Retry-After` value, honor it. Otherwise:

1. Stop issuing requests immediately; do not retry in a tight loop.
2. Use bounded exponential backoff with jitter, cap the number of attempts, and
   reduce the aggregate rate across all public routes because the limiter is
   shared.
3. Treat the window as an approximation: it is per process and resets on a fixed
   clock boundary, not necessarily 60 seconds after your response.
4. Do not interpret 429 as evidence about an anchor, corridor, rate, or
   reputation score.

## Report a problem safely

1. Reproduce the failure once and record the UTC time, HTTP method, path, and a
   redacted query string. Keep only public slugs and remove token-like values,
   full IPs, and customer data.
2. Record the HTTP status and `error.code` / `error.message`. If the response is
   a stale-evidence fallback, also record the bounded `X-Evidence-State` and
   related evidence headers described in the
   [dashboard recovery guide](dashboard-recovery-guide.md#step-2-verify-the-api-response-directly).
3. Include a proxy- or client-generated correlation ID only if one exists.
   State its source; current StellarCore responses provide no application ID.
4. Check known local setup issues in [Troubleshooting](troubleshooting.md) and
   the route-specific behavior in the [public API reference](api-reference.md).
5. Open an issue with the sanitized diagnostic payload and the exact request
   sequence. Do not attach raw server logs, credentials, or unredacted network
   captures. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the reporting workflow.

Errors and no-store responses are read-model diagnostics only. They do not
claim that an anchor is live or down, that a transfer occurred, that a firm
quote was available, or that an unsupported reputation score is valid.
