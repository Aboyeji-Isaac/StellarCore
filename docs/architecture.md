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
transfer-outcome evidence, and one current reputation score per anchor. The
database is the boundary between maintenance engines and read consumers.

Routes under `app/api/` expose anchors, corridors, rates, and reputation as
read-only JSON. They serialize bounded fields, avoid raw errors and internal
identifiers, and use no-store behavior where data is dynamic. The
server-rendered `/dashboard` uses the same read models, so the UI and public
API present the same persisted evidence and uncertainty semantics.

## Scheduled refresh and operations

The protected `GET /api/internal/cron/refresh` route requires the exact
`CRON_SECRET` bearer credential. It prepares and snapshots reviewed indicative
rates, then evaluates reputation. Rate preparation failures are returned in a
safe summary while reputation evaluation still runs; a fatal reputation
failure produces a safe server error. The production cron invokes this route
daily, while registry bootstrap remains a separate manual GitHub Actions job.

See the [README](../README.md) for setup, API details, and operational
invariants, and [DEPLOYMENT.md](DEPLOYMENT.md) for production procedures.

## Evidence integrity checkpoints

Immutable evidence history (rate observations, provenance records, immutable
reputation evaluations, and manifests) is covered by versioned cryptographic
checkpoints. Canonical serialization is explicitly versioned so that the
byte-level input to the hash is deterministic and stable across runtimes.
Checkpoints are keyless and hash-only: they detect missing, reordered, or
modified covered records within an ordered range, but they are not proof that
external evidence was true and do not attest to quote accuracy or transfer
success. Optional signing, if ever added, is a separate design layered on top
of the hash-only guarantee.

Checkpoints are append-only and never mutate the evidence they cover.
Incremental creation extends the chain from the previous checkpoint without
rehashing the complete database, preserving range and chain continuity.
Verification is read-only, requires no network access, and on failure
identifies the affected range without dumping sensitive values. Legacy
evidence may enter the first checkpoint as legacy evidence; missing
provenance is never fabricated.
