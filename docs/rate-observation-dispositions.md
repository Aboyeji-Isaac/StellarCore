# Rate observation dispositions

A persisted rate observation (`rate_snapshots` row) can be valid when captured
and still be shown wrong later: a semantically incorrect value, a compromised
source, or capture under an invalid configuration. Maintainers record a
**disposition** about such an observation. The evidence is never edited or
deleted. Every read model then reports the resulting gap truthfully.

A disposition is a maintainer decision about whether evidence can be used. It
is **not** a finding that an anchor acted maliciously, was unavailable, or
failed a transfer.

## Model

Dispositions are rows in `rate_observation_dispositions`. Each row is one
immutable event about one snapshot:

| Column | Meaning |
| --- | --- |
| `snapshot_id` | Target observation. `ON DELETE/UPDATE RESTRICT`. |
| `sequence` | 1, 2, … per snapshot. The highest sequence is the current state. Unique per snapshot. |
| `action` | `QUARANTINE`, `INVALIDATE`, `SUPERSEDE`, or `RELEASE`. |
| `reason_code` | Enumerated reason. Must be allowed for the action (table below). |
| `review_reference` | Required external review reference: an issue, PR, or ticket id or URL. 1–200 token characters. |
| `actor` | Maintainer identity; the GitHub actor in the workflow. 1–100 characters, `[A-Za-z0-9_.@-]`. |
| `note` | Optional. Whitespace is collapsed, at most 500 characters, no control characters. Internal only. |
| `superseded_by_snapshot_id` | Replacement observation. Required for `SUPERSEDE`, forbidden otherwise. |
| `recorded_at` | Database timestamp. |

The `rate_snapshots` table has no new columns. Existing observations have no
disposition rows. Absence means "never reviewed", **not** "reviewed and
accepted". The migration backfills nothing and modifies no existing row.

### State machine

```
active ──QUARANTINE──▶ quarantined ──RELEASE──▶ active
  │                        │
  ├──INVALIDATE──▶ invalidated (terminal)
  │                        ├──INVALIDATE──▶ invalidated
  └──SUPERSEDE───▶ superseded  (terminal)
                           └──SUPERSEDE───▶ superseded
```

`quarantined`, `invalidated`, and `superseded` block use as evidence. Any other
transition fails with `ILLEGAL_TRANSITION`: re-quarantining, releasing an active
observation, or acting on a terminal state.

| Action | Allowed reason codes |
| --- | --- |
| `QUARANTINE` | `SUSPECTED_INCORRECT_VALUE`, `SUSPECTED_SOURCE_COMPROMISE`, `SUSPECTED_INVALID_CONFIGURATION` |
| `INVALIDATE` | `SEMANTICALLY_INCORRECT`, `SOURCE_COMPROMISED`, `INVALID_CONFIGURATION`, `NORMALIZATION_DEFECT` |
| `SUPERSEDE` | `SEMANTICALLY_INCORRECT`, `INVALID_CONFIGURATION`, `NORMALIZATION_DEFECT` |
| `RELEASE` | `REVIEW_CLEARED` |

### Supersession

A replacement must be a **different, independently captured, persisted**
observation of the **same anchor and corridor**. It must be captured
**strictly later** than the target and must itself be **active**. Strict
capture ordering makes supersession chains acyclic. No synthetic correction row
is ever generated. If no such later capture exists, use `INVALIDATE` instead.

### Guarantees in the database

The migration enforces these rules even for raw SQL:

- `UPDATE`, `DELETE`, and `TRUNCATE` on `rate_observation_dispositions` are
  rejected by triggers.
- An insert trigger re-checks the state machine, contiguous sequencing, and
  supersession compatibility (same anchor and corridor, later capture, active
  replacement).
- CHECK constraints bound the reason code per action, the review reference,
  the actor, the note, and the replacement rules.
- The unique `(snapshot_id, sequence)` index, plus the tool's serializable
  transaction, lets only one of two concurrent dispositions of the same
  snapshot succeed. The other fails with `CONCURRENT_MODIFICATION`.

## Operator tool

There is no public write endpoint. Dispositions are recorded only through the
CLI or the protected workflow. Both default to a **dry run**, which performs
every validation and database check and writes nothing.

```bash
# Inspect a snapshot and its disposition history
npm run rates:disposition -- inspect --snapshot <uuid>

# Dry run, then apply
npm run rates:disposition -- invalidate --snapshot <uuid> \
  --reason SOURCE_COMPROMISED --review-ref https://github.com/Aboyeji-Isaac/StellarCore/issues/NNN \
  --actor <github-login> [--note "short context"]
npm run rates:disposition -- invalidate … --apply

npm run rates:disposition -- supersede --snapshot <uuid> --superseded-by <later-uuid> \
  --reason NORMALIZATION_DEFECT --review-ref GH-NNN --actor <login> --apply
```

Output is JSON with a bounded `code` on failure. The exit status is `1` for a
rejected request and `2` for usage errors. Database error messages are never
echoed.

The **Rate observation disposition** workflow
(`.github/workflows/rate-observation-disposition.yml`) is `workflow_dispatch`
only. It runs in the `production` environment (attach required reviewers
there), records the triggering GitHub actor as `actor`, and passes inputs
through environment variables so free text cannot inject shell commands. Leave
**apply** unchecked for a dry run.

## Read-model behavior

- **Latest rates (`GET /api/rates`, dashboard, corridor page).** The newest
  persisted observation per anchor is still selected deterministically
  (`captured_at DESC, id DESC`). If it carries a blocking disposition, it
  appears with `eligibleForMedian: false`, `exclusionReason` set to
  `invalidated`, `quarantined`, or `superseded`, and a `disposition` object
  (`state`, `reasonCode`, `recordedAt`). Its freshness stays truthful to its
  own capture time. **No older observation is promoted to current**, so the
  anchor contributes no median source until a newer valid observation is
  captured. The review reference, actor, and note are not public.
- **History.** `readRateObservationTimeline` (`lib/rates/observationTimeline.ts`)
  returns every stored point in capture order with `usable` and its
  disposition. Blocked points are kept, flagged, and never replaced or
  interpolated. The historical chart (#31 / PR #87) should consume this read
  model and render blocked points as flagged points or gaps.
- **Reputation.** Future evaluations drop a corridor's latest rate when that
  corridor's newest observation is blocked, without substituting an older one.
  Recording a disposition never touches `reputation_scores`. An
  already-persisted evaluation changes only when a later evaluation runs, as
  it always has. Immutable evaluation history is #114.

## Dependencies and coordination

- **#113 (provenance)** is not merged. Dispositions target snapshot ids, and
  capture-run and source lineage will be available on the target once #113
  lands. The disposition table needs no change for that.
- **#116 (constraints)**: this migration adds constraints only to the new
  table and leaves `rate_snapshots` untouched.
- **#148 (least-privilege roles)**: the runtime writer should get `SELECT`
  only on `rate_observation_dispositions`. `INSERT` belongs to the operator
  credential the disposition workflow uses.
