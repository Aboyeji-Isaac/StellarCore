# Rate-capture schedule and cadence contract

This document is the authoritative record for StellarCore's reviewed
rate-capture cadence: the versioned contract, the approved provider selection,
the failure modes, and what the cadence-health signal does and does not mean.

It is deliberately not a document about anchor health. A perfectly healthy
capture schedule says nothing about whether any anchor answered, whether a
quote was available, or whether a transfer settled.

## Why the schedule changed

`RATE_FRESHNESS_THRESHOLD_MS` is 120 seconds and is evaluated at read time. A
single daily run at `0 0 * * *` therefore produces observations that are fresh
for at most two minutes per day, no matter how successful the run is. The
previous single `/api/internal/cron/refresh` job captured reviewed rates and
evaluated reputation in one execution, so its schedule was simultaneously too
slow for capture and much faster than reputation needs to be.

The fix is a split, not a change to the freshness rule:

| Boundary | Route | Cadence | Authority |
| --- | --- | --- | --- |
| Reviewed rate capture | `GET /api/internal/cron/capture-rates` | Bounded by the contract below | Persist individual reviewed SEP-38 indicative observations |
| Reputation evaluation | `GET /api/internal/cron/refresh` | Daily (`0 0 * * *`) | Read persisted evidence and upsert one score per anchor |
| Cadence health | `GET /api/internal/capture-health` | Operator-invoked | Report capture-process health only |

Each boundary is independently authenticated with `Authorization: Bearer
<CRON_SECRET>` and each returns bounded, `no-store` JSON. Neither boundary
calls SEP-38 firm `/quote`, executes a transfer, reads a customer authentication
context, or serves public traffic. Public and dashboard requests read persisted
evidence through the public read models and never trigger capture.

`RATE_FRESHNESS_THRESHOLD_MS` and `MIN_FRESH_SOURCES` are unchanged. Faster
capture does not make one reviewed source independent or sufficient: with the
single reviewed Zeam USDC → BRL source the public median remains `null` with
`insufficient_fresh_sources`, and that is the correct answer at every cadence.

## The versioned scheduling contract

`constants/scheduling.ts` defines contract version `1`:

| Value | Definition |
| --- | --- |
| `RATE_CAPTURE_EXECUTION_BUDGET_MS` | Hard bound on the work one capture invocation performs. |
| `RATE_CAPTURE_SCHEDULER_JITTER_ALLOWANCE_MS` | Allowance for scheduler jitter, dispatch latency, and clock skew. |
| `RATE_CAPTURE_EXECUTION_HEADROOM_MS` | Documented safety margin = execution budget + jitter allowance. |
| `RATE_CAPTURE_MAX_INTERVAL_MS` | `RATE_FRESHNESS_THRESHOLD_MS − RATE_CAPTURE_EXECUTION_HEADROOM_MS`. |

At the current values the margin is 30 s and the maximum supported interval is
90 s: `90 s + 30 s = 120 s`, the exact freshness threshold. The maximum is
derived from the shared threshold, never restated as a literal in deployment
configuration. Bump the contract version when the meaning of these values
changes — not when a number changes.

An observation is captured at `t`, and a read at `t + interval + headroom` is
the worst case the contract has to survive. Anything the contract cannot prove
is rejected at validation time rather than assumed safe.

## Choosing and approving a provider

The production scheduler/provider choice is a maintainer decision recorded in
this document and on the tracking issue. Provisioning a provider account is
outside the change that introduced the contract and is not performed by
StellarCore.

Capture is **disabled by default**. `RATE_CAPTURE_SCHEDULER` is unset, resolves
to the explicit `disabled` state, and `GET /api/internal/cron/capture-rates`
refuses to run. That is intentional: capture must never begin at a cadence
nobody approved, and the default repository state must remain deployable on a
plan that cannot run a sub-minute schedule.

Checked-in provider manifests:

- `deploy/scheduler/vercel-cron.capture.json` — Vercel Cron at `* * * * *`
  (60 s). Requires a Vercel plan that supports per-minute cron. Select with
  `RATE_CAPTURE_SCHEDULER=vercel-cron` **and** merge the manifest's `vercelCron`
  fragment into `vercel.json` `crons[]`.
- `deploy/scheduler/external.capture.json` — any maintainer-approved external
  scheduler at a 60 s interval, dispatching `GET` with
  `Authorization: Bearer <CRON_SECRET>`. Select with
  `RATE_CAPTURE_SCHEDULER=external`.

The two are mutually exclusive. Selecting `external` while `vercel.json` still
schedules the capture route is a validation error, not a race.

To enable capture:

1. Record the maintainer approval for the provider in this document.
2. Apply the provider's configuration: merge the Vercel Cron fragment into
   `vercel.json`, or register the external schedule with the approved provider.
3. Set `RATE_CAPTURE_SCHEDULER` to the selected provider in the production
   environment (server-only; never a `NEXT_PUBLIC_*` value).
4. Run `npm run audit:scheduling` and require exit code 0.
5. Deploy, then confirm the first scheduled run appears in
   `GET /api/internal/capture-health`.

## Configuration validation

```bash
npm run audit:scheduling
```

The audit is offline and deterministic: it reads `vercel.json`, the checked-in
manifests, and the server-only scheduler selection. It uses no database,
network, or anchor access. It fails the process (`exit 1`) when:

- the capture interval plus the documented safety margin exceeds the freshness
  threshold (`CAPTURE_CADENCE_EXCEEDS_FRESHNESS_BUDGET`);
- the configured cron expression cannot be bounded, for example a
  calendar-qualified schedule (`UNSUPPORTED_CRON_EXPRESSION`);
- the selected provider has no manifest, or the deployment config disagrees
  with the approved manifest (`SCHEDULER_MANIFEST_MISSING`,
  `SCHEDULER_MANIFEST_MISMATCH`);
- deployment config schedules the capture route while no provider is selected,
  or two schedulers are pointed at the capture route
  (`CAPTURE_CRON_UNEXPECTED`);
- the independent daily reputation job is missing
  (`REPUTATION_CRON_MISSING`).

Selecting a provider with no capture cron entry is also a failure
(`CAPTURE_CRON_MISSING`), so a half-applied change cannot deploy silently.

Disabled is a warning (`CAPTURE_SCHEDULER_DISABLED`), not an error: an
unapproved repository is a valid state. The audit also runs on pull requests
that touch scheduling, deployment configuration, or the registry.

## Run identity, exclusion, and lineage

A capture invocation must be independently safe to retry, because a bounded
schedule means overlap and delayed dispatch are normal.

- **Exclusion.** Before any source work, the invocation takes a PostgreSQL
  session advisory lock on a dedicated connection keyed to a stable
  StellarCore-owned namespace. The connection is held for the whole run and
  released in `finally`; a dropped connection releases the lock automatically.
  A run that cannot acquire the lock returns a truthful `already_running`
  outcome, performs no source work, and persists nothing. It is not an error
  and not a failure: the previous run is still the current evidence.
- **Durable run identity.** Every invocation that is allowed to proceed writes
  a `rate_capture_runs` row before touching a source: run id, contract version,
  reviewed-configuration fingerprint, scheduler, planned interval, scheduled
  and start timestamps, and sanitized outcome counters. If lineage cannot be
  written, no observation is persisted.
- **Lineage and provenance.** Every `rate_snapshots` row written by capture
  references the run that produced it, and the run records the reviewed
  configuration fingerprint that was in force. A persisted observation is
  therefore always traceable to a run and a configuration. Failed or skipped
  sources write no snapshot at all.
- **Bounded execution.** Work stops when the execution budget is spent.
  Remaining reviewed sources are reported as `skipped` with reason
  `EXECUTION_BUDGET_EXHAUSTED`. They are not failed, not fabricated, and not
  backfilled on a later run.
- **Safe partial failure.** Each reviewed source is attempted independently. One
  failing source leaves successful independent observations committed, records
  its own sanitized failure code, and changes nothing else.
- **No sleeping loops.** There is no long-lived process, no in-function
  sleep-loop, and no self-rescheduling. Every invocation is bounded and
  independently authenticated.

These semantics intentionally match the run-state and recovery work described
in `docs/rfc-cron-locking.md`; capture consumes that contract rather than
introducing a competing ledger, and the reputation job keeps its own
independent schedule.

## Operator signal: cadence health

```
GET /api/internal/capture-health
Authorization: Bearer <CRON_SECRET>
```

```json
{
  "state": "delayed",
  "scheduledIntervalMs": 60000,
  "lastCompletedRunAt": "2026-09-28T12:00:00.000Z",
  "ageMs": 80000,
  "missedIntervals": 1,
  "contractVersion": 1,
  "signalScope": "stellarcore_capture_process",
  "notEvidenceOf": [
    "anchor_reachability",
    "price_or_quote_availability",
    "transfer_execution_success",
    "rate_freshness_or_median_eligibility"
  ]
}
```

`state` is derived from the last completed **scheduled** capture run:

| State | Meaning |
| --- | --- |
| `unknown` | No completed scheduled run is recorded, or no planned interval is known. Absence of lineage is not evidence that capture works. |
| `healthy` | Within the planned interval plus the jitter allowance. |
| `delayed` | Past the expected jitter but inside the largest interval the contract supports. Exactly one tick is late. |
| `missed` | Beyond the maximum supported interval. One or more ticks did not run. |

Manual `npm run snapshot:rates` runs are excluded so an operator cannot make
the signal look healthier than the schedule really is.

### Keep these four things separate

| Question | Where the answer lives | What it does not mean |
| --- | --- | --- |
| Did StellarCore's capture process run on time? | This endpoint's `state` | Anchor uptime, quote availability, transfer success, or rate freshness |
| Is the persisted observation fresh *right now*? | `GET /api/rates` freshness fields, computed at read time from `RATE_FRESHNESS_THRESHOLD_MS` | That the capture process is healthy |
| Is an anchor reachable and quoting? | Nothing in StellarCore claims this | A `LIVE` stored status is a record of the last synchronization, not current health |
| Did a transfer succeed? | Nothing — StellarCore executes and observes no transfers | An absent outcome is not a failure |

A `healthy` cadence with a stale observation is a contradiction only if you
conflate the first two rows. A delayed or missed run surfaces as `delayed` or
`missed` here while the rate read path independently reports the persisted
evidence as stale. The last known value is never relabelled fresh, no
observation is backfilled, and no synthetic quote, outcome, or score is created
to cover a scheduling gap.

## Failure-mode playbook

| Symptom | Meaning | Response |
| --- | --- | --- |
| `state: "already_running"` on a capture invocation | Another invocation holds the exclusion lock | None. Expected under a bounded cadence; no duplicate work occurred. |
| Cadence `delayed` | One tick ran late | Watch. The persisted evidence is still inside the freshness window. |
| Cadence `missed` | Scheduler did not dispatch | Check the provider's own dispatch history; StellarCore can only report what it observed. Expect stale or insufficient rate evidence until the next run. |
| `GET /api/rates` shows `insufficient_fresh_sources` with one fresh observation | The reviewed configuration has one source | Correct and expected. Adding sources is issue #7, not a scheduling fix. |
| Partial source failure | One reviewed source failed independently | The successful observations remain published. Investigate that source; no snapshot was written for the failure. |
| `UNSUPPORTED_CRON_EXPRESSION` from the audit | The deployed schedule cannot be bounded | Replace it with a schedule the audit can prove, or extend `lib/scheduling/cronExpression.ts` with a test. |
