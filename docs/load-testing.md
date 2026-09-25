# Load-testing plan and results — public API

A reusable k6 plan for the public read-only GET routes, and the real results
of running it on 2026-09-25 against a local production build, per #63. No
load was sent to the live production deployment, per the issue's
out-of-scope rule.

## The plan

**Script:** `tests/load/api-load.js` (k6). Each virtual user runs a weighted
mix approximating real traffic — 40% `GET /api/rates?corridor=…` (the
product's hot path), 20% `GET /api/reputation`, 15%
`GET /api/reputation/[slug]`, 15% `GET /api/anchors`, 10%
`GET /api/corridors` — with 0.5–2.5 s think-time between requests, so VU
count approximates *concurrent users*, not raw request floods.

**Method:** fixed-VU runs at increasing levels (5 → 15 → 30 → 50), 45 s
each, comparing per-endpoint p95 across levels to locate the degradation
point. Fixed levels give clean per-level tables; a single ramped run hides
the knee inside one aggregate.

**Running it** (any k6; the Docker image needs no install):

```bash
# 1. Database: local Postgres, committed migrations, seeded dataset
#    (24 anchors x 4 corridors, 90 days of hourly rate snapshots = 207,360
#    rows, plus 8,640 transfer outcomes and per-anchor reputation scores).
# 2. App: a production build, NOT the dev server:
DATABASE_URL=... npm run build && DATABASE_URL=... npm start
# 3. One run per level:
docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e BASE_URL=http://host.docker.internal:3000 -e VUS=15 \
  grafana/k6 run - < tests/load/api-load.js
```

**Never point `BASE_URL` at the live production API without explicit
maintainer confirmation.**

## Results (2026-09-25, real run)

Environment: local Windows host; `next start` (single instance, production
build of commit `7c36dc8`-era main — i.e. **without** the covering indexes
proposed in PR #70); Postgres 16 in Docker; dataset as above. Absolute
numbers are therefore not Vercel numbers — the shape and the ratios are the
signal, and serverless adds per-invocation overhead but also horizontal
fan-out this single instance does not have.

| VUs | req/s | Error rate | `/api/rates` p50 / p95 | `/api/reputation` p95 | `/api/reputation/[slug]` p95 | `/api/anchors` p95 | `/api/corridors` p95 |
| --- | ----- | ---------- | ---------------------- | --------------------- | ---------------------------- | ------------------ | -------------------- |
| 5   | 3.0   | 0%         | 260 ms / 621 ms        | 37 ms                 | 42 ms                        | 25 ms              | 21 ms                |
| 15  | 7.6   | 0%         | 664 ms / 2.87 s        | 338 ms                | 590 ms                       | 220 ms             | 538 ms               |
| 30  | 15.2  | 0%         | 602 ms / 2.73 s        | 797 ms                | 224 ms                       | 409 ms             | 123 ms               |
| 50  | 19.2  | 0%         | **1.55 s / 2.97 s**    | 1.64 s                | 1.11 s                       | 854 ms             | 866 ms               |

(928 requests at the 50-VU level; every request returned 200 at every level —
the Prisma pool and Postgres never failed, they just queued.)

## Findings

1. **`/api/rates` is the bottleneck from the first user.** 260 ms median at
   5 VUs and p95 near 3 s from 15 VUs onward. This is the known
   sort-the-whole-corridor-history query cost (measured independently in
   PR #70); under concurrency those sorts compete for the same cores and
   everything queues behind them.
2. **The system-wide knee is ≈ 30 concurrent users** on this hardware.
   Up to 30 VUs the cheap endpoints stay in tens-to-hundreds of ms while
   rates saturates; between 30 and 50 VUs *every* endpoint degrades
   (anchors median 16 ms → 240 ms), the signature of CPU/pool saturation
   spilling over rather than one slow query.
3. **Failure mode is latency, not errors: 0% errors at every level.**
   Nothing broke; requests queued. On serverless this converts to function
   timeouts and bill growth rather than 500s — which also means there is no
   error signal to alert on today, only latency.
4. **Throughput scaled sub-linearly** (3.0 → 19.2 req/s for 10× the users
   at ~1.5 s think-time-adjusted demand), confirming contention rather than
   capacity headroom.

## Where the current setup needs to scale

In priority order, matching the measured shape:

1. **Fix the rates query cost** — PR #70's covering indexes remove the
   per-request sort (2,935 → 197 ms warm in isolation). This moves the
   entire knee, since rates is both the hottest and the heaviest route.
2. **Shared response caching** — every route measured is read-only and
   `Cache-Control: no-store`. Rates change at cron cadence (daily), so even
   a short shared `s-maxage`/SWR would collapse repeated load to ~one DB hit
   per corridor per window, and is the cheapest large win.
3. **Rate limiting** (tracked in the threat model, #61): nothing bounds a
   single client today; the 0%-errors result means an abusive loop degrades
   everyone silently.
4. After 1–2, re-run this plan; the next expected ceiling is the Prisma
   connection pool / Postgres `max_connections` under serverless fan-out,
   which is a hosting configuration decision (pool size, PgBouncer) rather
   than a code change.

## Re-running after changes

The script is deterministic in shape (seeded slugs, fixed mix), so re-running
the same ladder after #70's indexes or a caching change yields directly
comparable tables. Keep the dataset generator and VU ladder identical when
comparing.
