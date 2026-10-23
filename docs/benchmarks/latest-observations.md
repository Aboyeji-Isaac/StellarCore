# Latest-observation query benchmark

Compares the two "newest row per group" reads before and after the lateral
rewrite (issue #150):

| Read | Groups | Before | After |
| --- | --- | --- | --- |
| `findLatestObservations` (`GET /api/rates`) | anchors, for one corridor | `DISTINCT ON (anchor_id)` over the corridor's history | one `LATERAL ... LIMIT 1` index probe per anchor |
| reputation `latestRates` | corridors, for one anchor | `DISTINCT ON (corridor.slug)` over the anchor's history | one `LATERAL ... LIMIT 1` index probe per corridor |

Regenerate with `npm run benchmark:latest-observations` (see the README). The
raw output is `latest-observations.json`; the `EXPLAIN (ANALYZE, BUFFERS,
FORMAT JSON)` plans for the ~1M-row scenario, before and after, are in `plans/`.

## Environment

- PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) on x86_64-pc-linux-gnu in a rootless podman container, default configuration
  (`shared_buffers` 128MB, `work_mem` 4MB, `random_page_cost` 4, `jit` on)
- Intel(R) Core(TM) i5-6300U CPU @ 2.40GHz x4, 15.5 GiB RAM, Linux 7.1.4-102.fc43.x86_64 x64, Node v24.18.0
- 7 timed runs per variant after 2 warm-ups; the median is reported
- Load average at start: [3.95, 6.02, 14.03] (1/5/15 min)

## Method

- **Data** is synthetic and deterministic: every value, including each snapshot
  id, is a pure function of (anchor, corridor, k). Each pair of anchor and
  corridor has `depth` snapshots one minute apart. No production data is used.
- **Each scenario starts from a fresh table** (`TRUNCATE`, then `VACUUM
  (ANALYZE)` after seeding). An earlier version cleared rows with `DELETE`,
  which left the indexes many times their proper size; the planner then
  costed the ordered index-only scan as far more expensive and flipped the old
  query to a sequential scan for reasons unrelated to the query. Those results
  were discarded.
- **Three variants** per read: `legacy` (the previous query, as the planner
  chooses to run it), `legacy-indexed` (the same query with `enable_seqscan =
  off`, forcing the ordered index-only scan the #70 covering indexes were built
  for, so the comparison is not against a sequential-scan strawman), and
  `lateral` (production, no planner settings changed). With the fresh indexes
  the planner chose the ordered index-only scan for `legacy` in every scenario
  anyway, so `legacy` and `legacy-indexed` are close.
- **Rows visited** is, summed over scan nodes, rows returned times loops plus rows
  removed by a filter. **Buffers** is shared hit plus read blocks of the root
  node. Both are deterministic for a given dataset; latency is not.
- **Query count** is 1 for every variant: no application-level N+1.
- Before timing, each scenario asserts the legacy and lateral queries return
  identical rows.

## Results: history depth grows, groups fixed (20 anchors x 3 corridors)

### Rates read (`findLatestObservations`, one corridor)

| Scenario | Snapshot rows | Groups | Median ms (legacy / indexed / lateral) | Rows visited (legacy / lateral) | Buffers (legacy / lateral) |
| --- | ---: | ---: | --- | --- | --- |
| depth-100 | 6,000 | 20 | 7.974 / 8.685 / 0.795 | 2,020 / 40 | 44 / 43 |
| depth-1000 | 60,000 | 20 | 41.735 / 41.985 / 0.786 | 20,020 / 40 | 441 / 63 |
| depth-10000 | 600,000 | 20 | 489.563 / 480.811 / 0.95 | 200,020 / 40 | 4,545 / 63 |
| million-rows | 1,000,020 | 20 | 1115.886 / 888.438 / 0.932 | 333,360 / 40 | 7,570 / 83 |

### Reputation read (`latestRates`, one anchor)

| Scenario | Snapshot rows | Groups | Median ms (legacy / indexed / lateral) | Rows visited (legacy / lateral) | Buffers (legacy / lateral) |
| --- | ---: | ---: | --- | --- | --- |
| depth-100 | 6,000 | 3 | 2.961 / 4.348 / 0.262 | 303 / 6 | 7 / 8 |
| depth-1000 | 60,000 | 3 | 28.995 / 29.63 / 0.248 | 3,003 / 6 | 53 / 11 |
| depth-10000 | 600,000 | 3 | 314.071 / 312.005 / 0.27 | 30,003 / 6 | 503 / 11 |
| million-rows | 1,000,020 | 3 | 610.796 / 690.713 / 0.329 | 50,004 / 6 | 837 / 14 |

## Results: group count grows (depth 500-1000)

### Rates read

| Scenario | Snapshot rows | Groups | Median ms (legacy / indexed / lateral) | Rows visited (legacy / lateral) | Buffers (legacy / lateral) |
| --- | ---: | ---: | --- | --- | --- |
| depth-1000 | 60,000 | 20 | 41.735 / 41.985 / 0.786 | 20,020 / 40 | 441 / 63 |
| anchors-100 | 300,000 | 100 | 307.294 / 268.673 / 7.124 | 100,100 / 200 | 2,271 / 304 |
| anchors-500 | 1,500,000 | 500 | 1090.353 / 1072.708 / 17.626 | 500,500 / 1,000 | 11,531 / 2,017 |
| corridors-30 | 600,000 | 20 | 54.748 / 44.271 / 0.838 | 20,020 / 40 | 445 / 62 |
| corridors-150 | 1,500,000 | 20 | 34.683 / 26.282 / 0.984 | 10,020 / 40 | 225 / 82 |

### Reputation read

| Scenario | Snapshot rows | Groups | Median ms (legacy / indexed / lateral) | Rows visited (legacy / lateral) | Buffers (legacy / lateral) |
| --- | ---: | ---: | --- | --- | --- |
| depth-1000 | 60,000 | 3 | 28.995 / 29.63 / 0.248 | 3,003 / 6 | 53 / 11 |
| anchors-100 | 300,000 | 3 | 30.537 / 35.226 / 0.288 | 3,003 / 6 | 52 / 11 |
| anchors-500 | 1,500,000 | 3 | 13.537 / 12.384 / 0.228 | 3,003 / 6 | 52 / 11 |
| corridors-30 | 600,000 | 30 | 118.308 / 109.984 / 2.068 | 30,030 / 60 | 551 / 92 |
| corridors-150 | 1,500,000 | 150 | 328.752 / 397.224 / 10.128 | 75,150 / 300 | 1,770 / 603 |

## Cold shared_buffers (one run right after restarting PostgreSQL), ~1M rows

| Read | Variant | Execution ms | Shared blocks read from outside shared_buffers |
| --- | --- | ---: | ---: |
| rates | legacy | 1445.792 | 7,569 |
| rates | legacy-indexed | 1741.058 | 7,569 |
| rates | lateral | 5.77 | 45 |
| reputation | legacy | 741.068 | 836 |
| reputation | legacy-indexed | 951.234 | 837 |
| reputation | lateral | 1.987 | 10 |

Cold here means empty `shared_buffers` only. The operating system page cache was
not dropped (that needs root), so this is not a cold-disk measurement.

## Reading the results

- **Work no longer depends on history depth.** The lateral form visits one row
  per group (40 rows for 20 anchors and 6 for 3 corridors: the group's own row
  plus its one newest snapshot) at every depth
  from 6,000 to about 1,000,000 rows. The previous form visits every historical
  row of the corridor (or anchor), so its rows visited, buffers and latency grow
  with depth.
- **What still grows is the group count**, as the issue anticipates: one index
  probe per anchor or corridor, so cost is proportional to the number of
  groups, which is small and bounded by the registry, not by history.
- **No small-dataset regression:** at 6,000 rows the lateral form is faster,
  not slower.
- **No new index was added.** The existing #70 covering indexes serve both
  probes (`rate_snapshots_latest_observation_idx` and
  `rate_snapshots_anchor_corridor_latest_idx`).

## Caveats

- Latency is from a shared laptop that was also running unrelated work, and
  from `EXPLAIN ANALYZE`, whose per-node timing adds overhead. Treat latency as a
  comparison between variants run back to back, and rows visited and buffers as
  the reliable numbers.
- One database version, one machine, evenly distributed synthetic data. Real
  quote histories are skewed, and a table this size on managed PostgreSQL with a
  different cache will differ in absolute numbers.
- Plain PostgreSQL 17; no extensions.
