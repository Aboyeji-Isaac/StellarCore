# StellarCore architecture

This document describes the behavior implemented in the current repository.
It is a prose companion to the system diagrams and does not describe planned
features as if they were production behavior.

## System shape

StellarCore is a Next.js App Router application backed by PostgreSQL through
Prisma. The browser dashboard and public API are read-only consumers of
persisted, bounded read models. Maintenance work is performed by explicit
scripts or the authenticated internal refresh route; public requests do not
discover anchors, call customer transfer endpoints, or write reputation
evidence.

The main data path is:

```text
reviewed registries
        │
        ├── manual bootstrap ──> anchor/corridor database records
        │
        └── scheduled refresh ──> SEP-38 rate snapshots
                                      │
                                      └──> reputation evaluation
                                                │
database read models <──────────────────────────┘
        │
        ├── public JSON APIs
        └── server-rendered dashboard
```

## Sync engine

The reviewed anchor registry in `constants/anchors.ts` is the source for the
manual `npm run bootstrap:registry` job. For each configured anchor,
`lib/stellar/anchorSync.ts` fetches and validates its `stellar.toml`, discovers
the supported SEP endpoints and assets, and upserts the result. A discovery
failure is classified and the existing anchor may be marked down; it is not
silently treated as a healthy anchor.

The corridor registry and anchor-to-corridor mappings in
`constants/corridors.ts` are synchronized in the same job. Corridor rows are
upserted and association rows are reconciled transactionally, including stale
association removal. The job reports structured failures and exits non-zero
when discovery or persistence did not complete successfully. It is idempotent
and never invents new anchors or corridors from network responses.

## Rate engine

Reviewed rate-source configuration determines which SEP-38 indicative-price
requests may be made. The scheduled refresh prepares those candidates,
fetches each source with the SEP-38 client, validates the response, and
persists successful observations as individual rate snapshots. A failed
source is isolated and reported; it does not turn an unverified response into
evidence.

The latest-rate read model selects the newest snapshot per anchor/corridor
source, evaluates freshness at read time, and calculates a median only from
the required number of fresh independent sources. Freshness is inclusive at
the configured threshold; future or invalid timestamps are excluded. The
public rates API exposes the bounded result and its freshness state without
performing a live upstream request.

## Reputation engine

`lib/reputation/engine.ts` evaluates each persisted anchor at one shared run
timestamp. It reads synchronized corridors, latest rate evidence, and
transfer-outcome rows from the configured trailing window. The score module
normalizes bounded evidence and calculates the documented weighted components
with deterministic integer basis-point arithmetic.

When evidence thresholds are not met, the result deliberately has no composite
score or score band and reports insufficient data. Otherwise the current
`ReputationScore` row is upserted for that anchor. The schema can represent
transfer outcomes, but the current product has no trusted production writer
for them and does not infer off-chain settlement from a successful Stellar
payment or Horizon observation.

## Database and public API

Prisma models anchors, corridors, their reviewed associations, rate snapshots,
transfer-outcome evidence, one current reputation score per anchor, and the
durable scheduled-refresh run ledger. The database is the boundary between
maintenance engines and read consumers.

Production database transport is guarded before pool construction by the
verified-TLS policy in `lib/database/tlsPolicy.ts`. The policy strips
connection-string TLS overrides, rejects plaintext or unverifiable production
modes, and passes an explicit certificate-verifying SSL object into the
hardened pool. Optional provider CA material remains server-only.

The database connection is managed through `@prisma/adapter-pg` backed by a
hardened `pg.Pool`. Connection acquisition and timeouts are bounded by
`connectionTimeoutMillis` and explicit request deadlines, with TCP keepalive
and connection lifetime recycling enabled. When transient primary failover or
endpoint rotation occurs, connection/failover errors trigger proactive eviction
of stale pooled connections to avoid sequential query failures against dead
sockets. Interrupted transactions never report success without positive commit
confirmation, and bounded pool capacity prevents connection storms against
newly promoted primaries. See `docs/database-failover.md` for full details.

Routes under `app/api/` expose anchors, corridors, rates, rate history, and
reputation as read-only JSON. Public failures use one shared bounded
`error.code` / `error.message` envelope and a common response serializer.
Unknown exceptions are retained only through the server-side reporter seam;
stack traces, database details, raw upstream responses, and secrets never enter
the public envelope. Successful response shapes and stale-evidence degradation
headers remain unchanged. Dynamic responses use no-store behavior. The
server-rendered `/dashboard` uses the same read models, so the UI and public
API present the same persisted evidence and uncertainty semantics.

## Integrity audit

`npm run audit:integrity` is a read-only, defense-in-depth check of the
persisted evidence graph. It loads a bounded snapshot of anchors, corridors,
reviewed memberships, rate snapshots, transfer outcomes, and reputation rows
using `findMany` selects only, then evaluates cross-table semantic invariants
that database constraints cannot fully express.

The pure evaluator emits bounded, deterministic findings keyed by stable record
identifiers, violation codes, and non-destructive remediation guidance. It does
not include raw evidence payloads in reports and does not write, update, delete,
or open a transaction. Database constraints and write-boundary validation remain
the first line of defense; this audit detects drift after migrations, imports,
or operational mistakes.

## Scheduled refresh and operations

The protected `GET /api/internal/cron/refresh` route requires the exact
`CRON_SECRET` bearer credential. It takes a session-scoped PostgreSQL advisory
lock, writes a durable refresh-run row, prepares and snapshots reviewed
indicative rates, then evaluates reputation. Rate preparation failures are
recorded as a failed phase while reputation evaluation still runs; a fatal
reputation failure is recorded truthfully and produces a safe server error.
Each attempt returns its run id and terminal state, and an attempt that cannot
take the lock returns a non-error `already_running` result without starting
work. The production cron invokes this route daily, while registry bootstrap
remains a separate manual GitHub Actions job.

See [runbook-scheduled-refresh.md](runbook-scheduled-refresh.md) for run-state
meanings, inspection, retry, and recovery, the [README](../README.md) for setup
and API details, and [DEPLOYMENT.md](DEPLOYMENT.md) for production procedures.
