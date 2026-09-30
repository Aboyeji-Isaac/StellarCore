# Anchor health policy: evidence-based availability transitions

This document specifies how StellarCore decides the published availability
status (`LIVE`, `DEGRADED`, `DOWN`, `UNKNOWN`) of a persisted anchor. The
implementation is the pure state machine in `lib/stellar/anchorHealth.ts`,
with thresholds in `constants/anchorHealth.ts` and the persistence boundary in
`lib/stellar/anchorSync.ts`.

## What status means

Status is **observational health of SEP-1 discovery**, maintained by
StellarCore's own synchronization runs. It is:

- **Not a claim about transfer success.** StellarCore does not execute or
  observe transfers; `LIVE` means the last complete discovery succeeded, not
  that payments work.
- **Not a claim about trustworthiness.** Reputation scoring is a separate
  evidence-based engine; availability is one bounded input to it, as
  documented in the README.
- **Not a real-time probe.** Status changes only when a sync run produces
  evidence.

## Failure taxonomy

Every SEP-1 discovery failure is classified into exactly one evidence class:

| Class | SEP-1 codes | Meaning |
|---|---|---|
| `TRANSIENT` | `TIMEOUT`, `NETWORK_FAILURE`, `RESPONSE_TOO_LARGE`, `HTTP_FAILURE` with 5xx or unknown status | Transport-class failure. The anchor may recover without changing anything. |
| `DETERMINISTIC` | `INVALID_HOME_DOMAIN`, `INVALID_TOML`, `INVALID_DATA`, `MISSING_REQUIRED_DATA`, `HTTP_FAILURE` with 4xx | Configuration or protocol failure. Retrying cannot succeed until the anchor changes its published state. |
| `UNKNOWN` | any unexpected error escaping discovery | Unclassified. Escalates no faster than `TRANSIENT` evidence. |

The taxonomy exists because a timeout and a deleted TOML file are different
claims: the first says "the network hiccuped", the second says "this anchor is
no longer publishing what it published before".

## Transition rules

Thresholds (constants/anchorHealth.ts):

- `ANCHOR_TRANSIENT_DEGRADED_THRESHOLD = 2` consecutive transient failures
  move `LIVE → DEGRADED`.
- `ANCHOR_TRANSIENT_DOWN_THRESHOLD = 3` consecutive transient failures move
  `LIVE → DOWN` (and `DEGRADED → DOWN`).
- `ANCHOR_DETERMINISTIC_DOWN_THRESHOLD = 2` consecutive deterministic failures
  move `LIVE → DEGRADED → DOWN` (one failure degrades immediately because the
  evidence is not retryable).
- `ANCHOR_TRANSIENT_SUSTAINED_WINDOW_MS = 48h`. A transient failure observed
  at least 48h after the previous one counts as sustained evidence and
  escalates `LIVE → DEGRADED` even if an intervening success reset the
  consecutive counter. This keeps the policy meaningful for infrequent sync
  cadences.
- `ANCHOR_RECOVERY_SUCCESS_THRESHOLD = 2` consecutive successful discoveries
  return `DOWN → DEGRADED → LIVE`. The first success after `DOWN` publishes
  `DEGRADED`; only repeated evidence clears it.

Exact rules:

1. **One transient timeout never changes a healthy anchor.** `LIVE` stays
   `LIVE` on a single transient or unknown-class failure; the failure is
   recorded as evidence only.
2. **Repeated failures escalate deterministically.** The same observation
   sequence always produces the same status sequence, in any process, on any
   worker.
3. **`DOWN` is sticky.** Further failures never deepen it; only recovery
   evidence changes it.
4. **Recovery requires positive evidence, repeated.** `LIVE` is published
   only after `ANCHOR_RECOVERY_SUCCESS_THRESHOLD` consecutive successes. The
   first success for a `DOWN` anchor publishes `DEGRADED`.
5. **A first-ever success publishes `LIVE` directly.** An `UNKNOWN` anchor
   with no history has no healthy claim to protect from flapping.
6. **Failures never publish `DEGRADED` for an anchor with no established
   history.** `UNKNOWN` requires the full `DOWN` threshold before it publishes
   `DOWN`.
7. **Persistence failures are never anchor evidence.** A database write error
   during a sync run is reported as `PERSISTENCE_FAILURE` and does not touch
   the anchor's health state.
8. **A successful discovery persists metadata only.** The anchor's SEPs,
   endpoints, and assets reflect the last complete validated discovery; the
   status column is owned by the health state machine.

With the default daily cron cadence this means: a transient blip on Monday
changes nothing; the same blip Monday and Tuesday publishes `DEGRADED`; three
consecutive days publishes `DOWN`; a restored anchor needs two clean days
before `LIVE` returns.

## Bounded persistence

Health evidence is stored in one row per anchor (`anchor_health_states`,
model `AnchorHealthState`):

- `status`, `consecutiveFailures`, `consecutiveSuccesses`
- `lastFailureClass`, `lastFailureCode` (bounded taxonomy values, no error
  text, no stack traces)
- `lastObservedAt`, `lastSuccessAt`, `lastFailureAt`, `lastTransitionAt`

The row contains only counters and timestamps. Nothing unbounded is stored:
no history, no per-run rows, no error payloads. Because the full machine
state is this one row, a restarted process or a different worker computes the
same next transition from the same evidence — the property that makes the
state machine deterministic across process restarts and horizontal execution.

## Public API wording

`GET /api/anchors` and `GET /api/anchors/:slug` continue to expose the four
`AnchorStatus` values. The dashboard presents them with evidence-based
labels:

| Status | Dashboard label |
|---|---|
| `LIVE` | Last sync succeeded |
| `DEGRADED` | Repeated sync failures |
| `DOWN` | Sustained sync failures |
| `UNKNOWN` | No sync evidence yet |

No wording claims current operation, transfer success, or trustworthiness.

## Relationship to other issues

- Discovery history retention (#120) can extend this ledger with richer
  evidence without changing these transition rules.
- Clock integrity (#137) matters for the sustained-evidence window: the
  machine compares observation timestamps recorded by StellarCore itself, so
  a single monotonic run clock is sufficient for deterministic transitions.
- Transfer execution and reputation scoring are out of scope here; the
  availability component of reputation reads this status exactly as before.
