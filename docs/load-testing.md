# Load-testing plan and results — public API

A reusable, reproducible k6 plan for the public read-only GET routes, and the
real results of running it on 2026-09-29 against a local production build of
current `main` (which includes PR #70's `rate_snapshots` covering indexes).
No load was sent to the live production deployment, per the issue's
out-of-scope rule.

## The plan

**Script:** `tests/load/api-load.js` (k6). Each virtual user runs a weighted
mix approximating real traffic — 40% `GET /api/rates?corridor=…` (the
product's hot path), 20% `GET /api/reputation`, 15%
`GET /api/reputation/[slug]`, 15% `GET /api/anchors`, 10%
`GET /api/corridors` — with 0.5–2.5 s think-time between requests, so VU
count approximates *concurrent users*, not raw request floods.

**Dataset:** `tests/load/seed.ts`, a deterministic load-test-only seeder.
Every slug it writes carries the `loadtest-` prefix, so synthetic rows can
never collide with — or be mistaken for — the reviewed registry that
`bootstrap:registry` maintains, and teardown removes exactly that prefix.
Values are index arithmetic, not `random()`: a fresh checkout reproduces the
documented dataset byte for byte. **Synthetic load data is measurement
fixture only and must never surface through the public product as real
Stellar evidence.**

**Method:** fixed-VU runs at increasing levels (5 → 15 → 30 → 50), 45 s
each, comparing per-endpoint p95 across levels to locate the degradation
point. Fixed levels give clean per-level tables; a single ramped run hides
the knee inside one aggregate.

## Reproducing the run (local only — never production)

```bash
# 1. Throwaway Postgres + schema (all committed migrations, PR #70 included):
docker run -d --rm --name stellarcore-load -e POSTGRES_PASSWORD=pw \
  -p 55450:5432 postgres:16-alpine
export DATABASE_URL="postgresql://postgres:pw@localhost:55450/stellarcore"
docker exec stellarcore-load psql -U postgres -c 'CREATE DATABASE stellarcore'
npx prisma migrate deploy

# 2. The deterministic dataset (24 anchors × 4 corridors × 90 days hourly
#    = 207,360 snapshots; ANCHORS/CORRIDORS/DAYS env vars override):
npx tsx tests/load/seed.ts

# 3. A production build, NOT the dev server:
npm run build && npm start

# 4. One k6 run per level (the Docker image needs no install):
docker run --rm -i --add-host=host.docker.internal:host-gateway \
  -e BASE_URL=http://host.docker.internal:3000 -e VUS=15 \
  grafana/k6 run - < tests/load/api-load.js

# 5. Remove every synthetic row (children first, loadtest-% scoped):
npx tsx tests/load/seed.ts --teardown
```

## Results (2026-09-29, current `main` with the #70 indexes)

Environment: local Windows host; `next start` (single instance, production
build); Postgres 16 in Docker; dataset as above. Absolute numbers are not
Vercel numbers — the shape and the ratios are the signal.

| VUs | req/s | Error rate | `/api/rates` p50 / p95 | `/api/reputation` p95 | `/api/reputation/[slug]` p95 | `/api/anchors` p95 | `/api/corridors` p95 |
| --- | ----- | ---------- | ---------------------- | --------------------- | ---------------------------- | ------------------ | -------------------- |
| 5   | 3.1   | 0%         | 16 ms / 53 ms          | 31 ms                 | 21 ms                        | 18 ms              | 30 ms                |
| 15  | 9.7   | 0%         | 25 ms / 113 ms         | 199 ms                | 25 ms                        | 33 ms              | 16 ms                |
| 30  | 19.0  | 0%         | 21 ms / 147 ms         | 18 ms                 | 24 ms                        | 161 ms             | 15 ms                |
| 50  | 31.6  | 0%         | 26 ms / 127 ms         | 31 ms                 | 29 ms                        | 136 ms             | 25 ms                |

(1,498 requests at the 50-VU level; every request returned 200 at every
level.)

## Findings

1. **No degradation point up to 50 concurrent users.** Median latency is
   essentially flat across the whole ladder (rates 16 → 26 ms) and
   throughput scales linearly with demand (3.1 → 31.6 req/s, exactly the
   ×10 the VU count implies under think-time) — the ladder never found the
   knee on this hardware. The previous revision of this document measured a
   system-wide knee at ≈30 users; that measurement predates the #70 indexes
   (appendix below).
2. **`/api/rates` is still the heaviest route, but no longer a problem**:
   ~25 ms median and 110–150 ms p95 under load, with the per-request sort
   of the corridor's history gone. Its p95 plateaus rather than growing
   with VUs — contention noise, not a scaling curve.
3. **The tail is spiky, not the median**: every route shows occasional
   300–700 ms maxima (a few per thousand requests) with clean p50/p90 —
   Node GC pauses and Docker networking on a laptop, worth re-measuring on
   real infrastructure before chasing.
4. **Failure mode remains latency, never errors: 0% at every level.**
   Nothing errors under this load; there is still no error signal to alert
   on, only latency.

## Where the current setup would need to scale

1. **Find the real ceiling**: 50 think-time users no longer approach it.
   The next bottleneck candidates are the Prisma connection pool /
   Postgres `max_connections` under serverless fan-out — a hosting
   configuration decision (pool size, PgBouncer) — and they need a rawer
   arrival rate (k6 `constant-arrival-rate`, no think time) to surface.
2. **Shared response caching is still the cheapest win**: every route
   measured is read-only and `Cache-Control: no-store`, while rates change
   at cron cadence. Even a short shared `s-maxage` would collapse repeated
   load to ~one DB hit per corridor per window.
3. **Rate limiting** (tracked in the threat model, #61): nothing bounds a
   single client, and the 0%-errors result means an abusive loop degrades
   everyone silently.

## Appendix: pre-#70 baseline (historical, 2026-09-25)

Kept only to document what the covering indexes bought; **the tables above
are the current baseline.** Same ladder, same dataset shape, same machine,
before `rate_snapshots_latest_observation_idx` /
`rate_snapshots_anchor_corridor_latest_idx` existed:

| VUs | req/s | `/api/rates` p50 / p95 | Notes |
| --- | ----- | ---------------------- | ----- |
| 5   | 3.0   | 260 ms / 621 ms        | rates already the bottleneck at one user |
| 15  | 7.6   | 664 ms / 2.87 s        | rates saturated |
| 30  | 15.2  | 602 ms / 2.73 s        | system-wide knee ≈ here |
| 50  | 19.2  | 1.55 s / 2.97 s        | every endpoint degrading together |

Post-#70, the same 50-VU rates p95 is **127 ms — roughly 23× better** — and
the knee is gone from the measurable range.

## Re-running after changes

The seeder and the script are deterministic, so re-running the same ladder
after a caching change (or on different hardware) yields directly comparable
tables. Keep the dataset parameters and VU ladder identical when comparing.
