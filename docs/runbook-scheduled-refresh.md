# Runbook: scheduled refresh locking and recovery

This runbook covers the durable state that `GET /api/internal/cron/refresh`
writes, how to inspect it, and how to safely retry a run. It implements the
locking and run-ledger recommendation in [rfc-cron-locking.md](rfc-cron-locking.md).

The refresh orchestrator lives in `lib/scheduled/refresh.ts`. The state machine
is `lib/scheduled/refreshRunState.ts`, the ledger repository is
`lib/scheduled/refreshRunRepository.ts`, and the advisory-lock provider is
`lib/scheduled/refreshLock.ts`.

## Mutual exclusion

Every attempt tries `pg_try_advisory_lock(namespace, key)` on a dedicated
PostgreSQL session before doing any work:

- The lock is **session-scoped, not transaction-scoped**. External SEP requests
  are never wrapped in a long-running database transaction.
- The lock is held for the whole orchestration and released in `finally` on
  success, handled failure, timeout, and thrown exceptions. If the process
  dies, PostgreSQL releases the session lock automatically.
- When the lock is already owned, the attempt returns a **non-error**
  `already_running` result with an ephemeral attempt id in `runId` and, when the
  active row is readable, the conflicting persisted id in `activeRunId`. No
  phase work runs and no run row is written.

The cron response is the only place an ephemeral attempt id appears; it is
never persisted.

## Run states

| State | Meaning |
| --- | --- |
| `RUNNING` | An attempt owns the lock and is executing phases. A `RUNNING` row with no owning session is an interrupted run. |
| `SUCCEEDED` | Every required phase reached its defined success state in this attempt or was carried from a prior attempt. |
| `PARTIALLY_SUCCEEDED` | At least one phase succeeded and at least one did not. This is **not** success. |
| `FAILED` | No phase succeeded, or the run was interrupted. |

Terminal states are final. A retry/resume creates a **new** row linked through
`resumedFromId`; history is never reopened.

## Phase states

| State | Meaning |
| --- | --- |
| `PENDING` | The phase has not started in this attempt. |
| `RUNNING` | The phase is executing. |
| `SUCCEEDED` | The phase completed with zero reported failures. |
| `FAILED` | The phase completed with failures, or could not run at all (for example a rate preparation failure). |
| `SKIPPED` | Reserved for a documented operator recovery decision. The orchestrator never writes it on its own, and a skipped required phase can never yield `SUCCEEDED`. |

A run may be marked `SUCCEEDED` only when every required phase reaches
`SUCCEEDED`. Partial completion, missing evidence, and skipped phases are never
converted into success. Resuming carries forward only phases that already
reached `SUCCEEDED` with a readable persisted summary; it never fabricates rate
snapshots, anchor reachability, transfer outcomes, or reputation evidence.

## Inspection

The read-only CLI prints the persisted ledger without touching network or
making writes:

```bash
# Recent runs with state, attempt, resume link, and per-phase states
npm run refresh:runs -- list 20

# One run's full persisted record, including bounded failures
npm run refresh:runs -- show <runId>
```

Equivalent SQL:

```sql
SELECT id, state, attempt, resumed_from_id, started_at, completed_at
FROM refresh_runs
ORDER BY started_at DESC
LIMIT 20;

SELECT id, state, attempt, phase_states, failures
FROM refresh_runs
WHERE id = '<runId>';
```

`phase_states` holds each phase's `state`, `startedAt`, `completedAt`, and a
bounded summary. `failures` holds bounded, sanitized entries only — never
secrets, authorization headers, raw remote response bodies, or stack traces.

## Retry and recovery rules

1. **Interrupted run.** If the process died while `RUNNING`, the next attempt
   that acquires the lock reclaims the row as `FAILED` with an
   `ORCHESTRATION` / `INTERRUPTED_ORPHANED_RUN` failure before it starts its own
   work. No operator action is required to clear the stale row.
2. **Failed or partially succeeded run.** Resume it explicitly:

   ```bash
   npm run refresh:runs -- resume <runId>
   ```

   Resume is allowed only for a `FAILED` or `PARTIALLY_SUCCEEDED` run. It:

   - creates a new run with `attempt = prior.attempt + 1` and
     `resumedFromId = prior.id`;
   - carries forward phases that already reached `SUCCEEDED` and have a readable
     persisted summary, without re-executing them;
   - re-runs every other phase, because a phase with no readable success
     evidence must not be reported as successful;
   - acquires the advisory lock first, so it cannot overlap a scheduled run.

3. **Never do this.** Do not `UPDATE refresh_runs SET state = 'succeeded'`
   directly. Database check constraints reject malformed rows, but manually
   writing a terminal state bypasses the phase evidence that the state must
   reflect. Re-run the phase instead.

## Operational notes

- Schema changes ship as reviewed Prisma migrations and are applied through the
  manual production-migration workflow before the application uses them.
- The advisory lock guards the refresh orchestration only. Registry bootstrap
  has its own workflow concurrency group and does not take this lock.
- Structured `refresh_run_*` log lines carry the run id, phase, and terminal
  state. Field names are intentionally kept stable; coordinate any change with
  the structured-logging work tracked in #58.
