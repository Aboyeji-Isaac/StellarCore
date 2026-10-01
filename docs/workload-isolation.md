# Database Workload Bulkheads

StellarCore partitions every PostgreSQL connection into independent workload-class
pools so that a heavy public-read burst or a long scheduled evidence run can never
starve the other. This document describes the capacity model, the overload contract,
and the verification commands.

## Workload classes

| Class | Used by | max | min (reserved) | acquisition timeout | statement timeout |
| --- | --- | --- | --- | --- | --- |
| `public` | public API routes, latest-rate reads | 50 | 5 | 5s | 10s |
| `scheduled` | rate snapshots, reputation evaluation | 30 | 3 | 30s | 60s |
| `maintenance` | anchor/corridor sync | 10 | 0 | 10s | 30s |

Configuration lives in `lib/config/workloadBudgets.ts`; the per-class hardened
pools, lazy clients, stats, and saturation helpers live in
`lib/db/workloadClient.ts` (built on `lib/db/poolManager.ts` + the shared TLS
policy); repositories and API routes bind to a class through
`lib/db/workloadAccessor.ts`.

## Capacity model

- Each class gets its own `pg.Pool` with `max = maxConnections`, so one class can
  never borrow another class's reserved capacity.
- Total maximum across classes is limited to 90 of the documented 100-connection
  provider budget (`TOTAL_MAX_CONNECTIONS <= 100`, enforced by
  `validateWorkloadBudgets` at module load and re-validated before pool creation).
- Reserved minimums (5 + 3 + 0 = 8) keep the scheduler able to acquire capacity
  even while public traffic is saturating the public pool.

## Overload behavior per class

- `public` fails fast: a public read that cannot get a connection within 5s
  returns an error rather than hanging; statements die after 10s.
- `scheduled` is more patient (30s acquisition, 60s statement) because evidence
  work is batch-oriented and can queue, but it is still bounded.
- `maintenance` never borrows (`canBorrow: false`) so syncs cannot displace
  user-facing capacity.

## Recovery

`shutdownWorkloadClients()` ends every initialized pool; no connections or
waiters are stranded. Clients and pools are cached once per process on
`globalThis`, including in production, so repeated repository access never
creates extra pools. Environment-isolation verification (#143,
`ensureDatabaseEnvironment`) still runs before any evidence read or write,
independent of which workload pool serves the query.

## Verification

- `npm test` — unit budget validation (`tests/unit/config/workloadBudgets.test.ts`),
  pool wiring (`tests/unit/db/workloadClient.test.ts`), and concurrent
  multi-workload saturation tests (`tests/integration/db/workloadSaturation.integration.test.ts`).
- `tests/integration/db/connectionBudget.integration.test.ts` proves acquisition
  against an unresponsive database fails within the bounded timeout.
- `npm run audit:compatibility`, `npm run audit:config`, and `npm run audit:sql` gate API contract drift, registry consistency, and raw-SQL boundary violations.
