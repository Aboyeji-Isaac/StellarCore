# Clock integrity

StellarCore persists evidence that is only meaningful when its timestamps are
honest. A materially incorrect application clock would otherwise be able to
create future observations, extend the freshness window, distort rolling
reputation windows, or misorder history. This document describes the single
boundary that prevents that.

## One server-side clock

`lib/clock/clock.ts` exposes the only clock the evidence path may read:

- `SYSTEM_CLOCK` is the production server clock.
- `createControlledClock(initial)` is a deterministic test clock that supports
  `set`/`advance` so forward and backward movements are reproducible.

Capture (`runRateEngine`), freshness (`getRateFreshness`,
`computeFreshMedian`), the read model (`readLatestCorridorRate`), and reputation
evaluation (`evaluateAnchorReputation`, `evaluatePersistedAnchorReputations`)
all default to this abstraction. Client or browser time is never used for an
evidence decision.

## The boundary

Before a persisted-evidence run writes anything, `checkClockIntegrity`
(`lib/clock/integrity.ts`) performs **one** run-level comparison:

1. Read the application instant from the shared clock.
2. Read PostgreSQL's `clock_timestamp()` through
   `PRISMA_DATABASE_CLOCK_READER`.
3. Compare them with `assessClockIntegrity`, a pure function.

A single check covers the whole run, so there is no per-row round trip.

| Boundary | Where |
|---|---|
| `RATE_CAPTURE` | `snapshotReviewedLiveRates` (`lib/rates/snapshotRun.ts`) |
| `REPUTATION_EVALUATION` | `evaluatePersistedAnchorReputations` (`lib/reputation/run.ts`) |

When the verdict is rejected, the run stops before any source is quoted or any
anchor is scored: no `RateSnapshot` and no `ReputationScore` is written.

## Reviewed tolerance

`CLOCK_MAXIMUM_SKEW_MS = 5000` (`constants/clock.ts`) is the reviewed maximum
disagreement between the application clock and PostgreSQL. It is far below the
120-second freshness window (`RATE_FRESHNESS_THRESHOLD_MS`), so tolerable skew
can never make an observation look fresh that is not.

- **Positive** skew (application clock ahead) is rejected so a future
  observation is never persisted. Independently, any `capturedAt` after the
  evaluation instant is classified `future` and is never `fresh`.
- **Negative** skew (application clock behind) is rejected so an observation
  cannot be made to appear fresher than it is.

A backward clock movement within tolerance is allowed but is not "corrected":
timestamps are never silently rewritten. Persisted ordering remains
deterministic because histories sort by `capturedAt` with the snapshot id as a
stable tie-breaker.

## Bounded provenance

Each check writes one bounded row to `clock_integrity_checks`
(`ClockIntegrityCheck`): boundary, outcome, typed code, optional run id, the
application and database instants, the skew, and the tolerance. Values are
clamped and field-length-bounded by CHECK constraints, so a pathological clock
cannot store unbounded metadata. Rejected checks are retained (quarantined)
rather than discarded.

The database instants are authoritative; the application instant is retained
only as system-integrity evidence. Clock agreement is system-integrity evidence,
not anchor-availability evidence, and it is stored separately from
`RateSnapshot` and `ReputationScore`.

If a passed check cannot persist its provenance row, the gate fails closed with
`CLOCK_METADATA_PERSISTENCE_FAILURE` rather than persisting evidence under an
unverifiable clock.

## Typed failures

`ClockIntegrityFailureCode` values are safe to serialize and carry no
configuration, credentials, or stack traces:

| Code | Meaning |
|---|---|
| `CLOCK_SKEW_EXCEEDED` | `abs(application - database) > tolerance` |
| `CLOCK_READ_FAILURE` | PostgreSQL clock could not be read |
| `INVALID_CLOCK_VALUE` | a non-finite instant was supplied |
| `CLOCK_METADATA_PERSISTENCE_FAILURE` | provenance row could not be stored |

In the scheduled-refresh result the code appears as a run-level
`CLOCK_INTEGRITY` rate failure and/or a `ReputationEvaluationRunFailure` without
an anchor slug. The authoritative `ClockIntegrityVerdict` is also attached to
the run summary.

## Integration testing

```bash
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE" \
RUN_CLOCK_INTEGRITY_DATABASE_INTEGRATION=1 npm test tests/integration/clock
```

The database tests verify that PostgreSQL's clock is readable and comparable,
that a matching-clock run passes and persists one bounded row, that excessive
positive skew is rejected and quarantined, that existing persisted timestamps
are never rewritten, and that a future timestamp is never treated as fresh.
