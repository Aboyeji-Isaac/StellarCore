# Observability

StellarCore emits vendor-neutral OpenTelemetry traces and metrics for public API
reads, the scheduled refresh, PostgreSQL work, and outbound SEP-1/SEP-38
requests. The goal is to let operators see latency, queueing, missed evidence
runs, and phase failures, including slowdowns that finish without errors.

## System telemetry is not evidence

Telemetry describes **StellarCore's own execution**. A fast SEP-38 span shows
only that StellarCore got a timely HTTP response. It is not evidence that an
anchor is reachable for customers, that a quote is correct, or that a transfer
succeeded. Freshness metrics describe rate observations that were already
persisted and evaluated. They never create, refresh, or re-date rate evidence.
Anchor, rate, and transfer evidence live only in the database and the public
API responses.

## Enabling export

Telemetry is off unless an OTLP endpoint is configured. With no endpoint, no SDK
is registered and every instrument is an OpenTelemetry API no-op. The bootstrap
is `instrumentation.ts`. It runs only in the Next.js **Node.js** runtime and
uses no Edge-only APIs.

All configuration uses standard, server-only `OTEL_*` variables. None are
`NEXT_PUBLIC_*`, and the client bundle contains no exporter code or endpoint.

| Variable | Default | Effect |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset (telemetry off) | OTLP/HTTP base URL; `/v1/traces` and `/v1/metrics` are appended. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset | Per-signal full URLs; enable just one signal. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Collector credentials, for example `authorization=Bearer …`. **Secret.** Read by the exporter, never logged. |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` | `otlp` | Set to `none` to disable one signal. |
| `OTEL_SDK_DISABLED` | `false` | `true` disables everything. |
| `OTEL_TRACES_SAMPLER_ARG` | `1` | Root sampling ratio in `[0, 1]` for the parent-based trace-id-ratio sampler. Invalid values fall back to `1`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | Metric export interval in milliseconds. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | `stellarcore` | Resource identity. `deployment.environment.name` defaults to `VERCEL_ENV` or `NODE_ENV`. |

An endpoint that is not `http(s)://` disables telemetry and prints one fixed
line, `{"level":"warn","component":"telemetry","code":"TELEMETRY_INVALID_ENDPOINT"}`,
without the endpoint.

## Failure behavior

Telemetry never blocks or fails a request, a scheduled run, or an evidence write:

- Instrumentation returns the wrapped operation's value or error unchanged.
  Typed SEP failures (`Sep1DiscoveryError`, `Sep38ClientError`) and safe API
  error envelopes are preserved exactly.
- Spans are exported in the background by a bounded batch processor: at most
  2,048 queued spans (extra spans are dropped), batches of 512, and a 5 s
  export timeout. Metrics export on an interval with a 5 s timeout, capped at
  the interval.
- On serverless hosts (`VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` set), route
  handlers schedule one flush after the response via Next.js `after()`. It is
  capped at 2 s and resolves whether the export succeeds, fails, or hangs.
- An unavailable collector produces at most one fixed diagnostic line per
  minute, `{"level":"warn","component":"telemetry","code":"TELEMETRY_EXPORT_FAILURE"}`.
  OpenTelemetry's own diagnostics are suppressed because they can include
  endpoints or response bodies.

## Redaction

All attributes use a bounded vocabulary (`lib/telemetry/semantics.ts`). The
same allowlist is enforced **at the export boundary** by
`RedactingSpanExporter`, so spans created by Next.js or any library are
redacted too:

- Attributes whose key is not listed below are dropped. This removes
  `http.target`, `http.url`, `url.full`, peer addresses, and `db.query.text`,
  among others. Values must be short (at most 64 characters), token-like, and
  contain no `//`.
- Span names are cut at the first URL or query string. For example,
  `fetch GET https://host/path?x=1` is exported as `fetch GET`.
- Span events are removed, because exceptions carry messages that can include
  URLs. Status messages and link attributes are removed as well.
- Failures are recorded as a typed `error.type` code only (for example
  `TIMEOUT`, `HTTP_FAILURE`, `ECONNREFUSED`, or `500`), never as a message or
  stack.

Nothing records authorization headers, cron or SEP-10 tokens, connection
strings, SQL text, request or response bodies, raw quotes, anchor domains,
slugs, snapshot ids, or quote ids. `tests/unit/telemetry/traces.test.ts` and
the load run below check this against everything exported.

## Spans

| Span | Parent | Attributes |
| --- | --- | --- |
| `GET <route template>` | Next.js request span | `http.request.method`, `http.route`, `http.response.status_code`, `error.type` on 5xx |
| `<operation> <Model>` (for example `findMany Anchor`, `$queryRaw`) | Route or refresh phase | `db.system.name`, `db.operation.name`, `db.collection.name`, `stellarcore.db.client`, `error.type` |
| `stellarcore.refresh.run` | Cron route | `stellarcore.result` |
| `stellarcore.refresh.phase rates` / `… reputation` | Refresh run | `stellarcore.refresh.phase`, `stellarcore.result` |
| `SEP-1 toml`, `SEP-38 info` / `prices` / `price` / `quote` | Refresh phase | `stellarcore.sep`, `stellarcore.sep.operation`, `http.response.status_code` on HTTP failures, `error.type` |

Public API routes make no SEP calls, and telemetry adds no network or database
work to them.

## Metrics

Durations are in seconds, using buckets `0.005 … 10` extended to `30, 60, 120,
300`. Ages use buckets from one minute to one week.

| Metric | Type | Unit | Attributes | Series budget |
| --- | --- | --- | --- | --- |
| `http.server.request.duration` | histogram | s | method, `http.route`, status code, `stellarcore.result` (`ok`/`client_error`/`server_error`) | 8 routes × ~4 statuses |
| `http.server.active_requests` | up-down counter | {request} | method, `http.route` | 8 |
| `db.client.operation.duration` | histogram | s | `db.operation.name`, `db.collection.name`, `stellarcore.db.client`, `error.type` | ~15 operations × 6 models × few errors |
| `db.client.connection.count` | gauge | {connection} | `db.client.connection.pool.name`, `db.client.connection.state` (`used`/`idle`) | 2 per pool |
| `db.client.connection.pending_requests` | gauge | {request} | `db.client.connection.pool.name` | 1 per pool |
| `stellarcore.sep.request.duration` | histogram | s | `stellarcore.sep`, `stellarcore.sep.operation`, `stellarcore.result` (`OK` or typed code) | 2 × 6 × ~12 |
| `stellarcore.refresh.runs` | counter | {run} | `stellarcore.result` (`success`/`partial_failure`/`failure`) | 3 |
| `stellarcore.refresh.run.duration` | histogram | s | `stellarcore.result` | 3 |
| `stellarcore.refresh.phase.duration` | histogram | s | `stellarcore.refresh.phase`, `stellarcore.result` | 6 |
| `stellarcore.refresh.phase.items` | counter | {item} | `stellarcore.refresh.phase`, `stellarcore.refresh.item_result` (`succeeded`/`failed`/`skipped`) | 6 |
| `stellarcore.rate.observations` | counter | {observation} | `stellarcore.freshness.state` (`fresh`/`stale`/`future`/`invalid`) | 4 |
| `stellarcore.rate.observation.age` | histogram | s | `stellarcore.freshness.state` | 3 (no age for `invalid`) |

No metric carries slugs, ids, domains, or timestamps. A new attribute or value
needs review against this budget.

## Interpreting signals

- **Queueing without errors.** Rising `db.client.connection.pending_requests`
  and `used` connections at the pool size, together with rising p95 of
  `http.server.request.duration` and `db.client.operation.duration` and a flat
  `server_error` count, mean requests are waiting for connections. They are
  not failing. Operation duration includes the wait for a pool connection.
- **Missed evidence runs.** `stellarcore.refresh.runs` should increase once
  per scheduled cycle (daily, `0 0 * * *`). No increase for more than one
  period means a missed or crashed run. A growing `stellarcore.rate.observation.age`
  and a shift from `fresh` to `stale` in `stellarcore.rate.observations`
  confirm it from the persisted data's point of view.
- **Phase failures.** Check `stellarcore.refresh.phase.duration` and
  `stellarcore.refresh.phase.items{item_result="failed"}` by phase, then the
  `SEP-*` spans' `error.type` for the typed cause.
- **Freshness counts are read-driven.** They count observations as public reads
  evaluate them, so they scale with traffic. Compare their proportions, not
  their absolute counts.
- Counters and histograms are cumulative per process. On serverless, each
  instance reports its own series. Aggregate across instances in the backend.

## Log and run correlation

`currentTraceContext()` (`lib/telemetry/core.ts`) returns the active
`traceId`/`spanId`. StellarCore has no shared structured logger yet. When #58
lands, its logger should add these two fields to every record; this PR adds no
competing log format. Durable scheduled-run identity belongs to #111. Once it
lands, its run id should be set as an attribute on the
`stellarcore.refresh.run` **span** (never a metric label, where it would be
unbounded), and the phase state it records can be compared with the phase
spans.

## Synthetic signals

Tests use in-memory exporters and never export. Load or synthetic runs must set
`OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=<name>,stellarcore.synthetic=true"`
and must not point at production data, so their telemetry can never be read as
production anchor activity.

## Baseline measurement procedure

No SLO, uptime percentage, or capacity threshold is defined. Targets require
observed production data and maintainer approval.

1. Enable export in the target environment and let at least 14 daily refresh
   cycles complete.
2. Record per-route p50/p95/p99 of `http.server.request.duration`, the peak of
   `db.client.connection.pending_requests`, the distribution of
   `stellarcore.refresh.run.duration` and phase durations, SEP result mix, and
   the freshness-state proportions.
3. Repeat under the repeatable load shape from #63 / PR #79 against an isolated
   environment marked synthetic (above), and note the concurrency at which
   `pending_requests` first rises above zero.
4. Propose any thresholds on the issue tracker with the measured data attached.

A local run on 2026-09-29 is an example of what the metrics can show, **not** a
baseline. It used synthetic data on a developer laptop against embedded
PostgreSQL 17, with `next start`, a pool of 10, and requests to `/api/rates`,
`/api/anchors`, and `/api/reputation`:

| Phase | Clients | Requests | HTTP errors | Mean request (metric) | Mean DB op (metric) | Max `pending_requests` | Max `used` connections | Max `active_requests` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline | 1 | 558 | 0 | 12 ms | 7 ms | 0 | 1 | 1 |
| Burst | 200 | 2,536 | 0 | 1,388 ms | 1,041 ms | 189 | 10 | 199 |

The error rate stayed at zero while queueing was plainly visible in the pool
and duration metrics.
