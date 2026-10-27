# Scheduled evidence pipeline fault-injection matrix (issue #171)

This document defines the deterministic fault matrix for the scheduled rate
and reputation pipelines and maps each scenario to its test. The suite proves
one core property in every failure class: **a failed scenario never fabricates
fresh evidence and never reports false success**, and **reruns recover against
partial progress without duplicating evidence**.

## Design

All faults are injected through the same dependency seams the production code
already exposes (`quote`, `repository`, `readEvidence`, `upsertScore`,
`snapshotRates`, `evaluateReputation`). The kit in `tests/faults/faultKit.ts`
provides:

- `clock()` — a stepped virtual clock; deadlines fire on simulated time, so
  deadline tests are instant and never flaky.
- `sequenced(outcomes, ok)` — a call-count-sequenced responder: each call
  either succeeds or throws the queued fault in a fixed order. Sequence
  exhaustion defaults to success, so no trailing entries are needed.
- `failAfter(seam, n, code)` — succeed `n` times, then always fail: models a
  database that disappears mid-cycle.
- `faultSnapshotRepository(ledger, faults)` / `faultReputationRepository(ledger, evidence, faults)`
  — per-method fault seams over durable in-memory ledgers, so tests can
  verify exactly which evidence rows survived a failure.
- `InjectedFaultError` / `DeadlineError` — faults carry only scenario-local
  codes; nothing from the environment can leak into a summary.

No live anchors, no external network, no real database are used. The suite is
fully offline and hermetic.

## Matrix

| ID | Layer | Injected fault | Expected safe outcome | Test |
|---|---|---|---|---|
| R1 | Quote fetch | network failure on source 1 | `QUOTE` failure for that source only; other sources persist; no fabricated success | `rateEngineFaults.test.ts` |
| R2 | Snapshot persistence | write failure on source 2 | `PERSISTENCE` failure attributed correctly; prior rows intact; later sources unaffected | `rateEngineFaults.test.ts` |
| R3 | Snapshot persistence | database disconnects mid-cycle | every later write fails; committed rows survive; partial truth in summary | `rateEngineFaults.test.ts` |
| R4 | Quote fetch | deadline exceeded | surfaces as `QUOTE_FAILURE`; no partial row for the cancelled source | `rateEngineFaults.test.ts` |
| R5 | Normalization | malformed quote | `NORMALIZATION` failure; zero database reads; nothing written | `rateEngineFaults.test.ts` |
| R6 | Candidate prep | duplicate candidate | skipped without consuming quote/persistence budget | `rateEngineFaults.test.ts` |
| R7 | Recovery | rerun after all-writes-fail | rerun completes the set; no duplicated rows | `rateEngineFaults.test.ts` |
| R8 | Evidence integrity | value round-trip | persisted snapshots echo inputs exactly; no fabricated values | `rateEngineFaults.test.ts` |
| P1 | Reputation read | evidence-read DB timeout | `EVIDENCE_READ_FAILURE`; no score write | `reputationFaults.test.ts` |
| P2 | Reputation write | score-upsert connection lost | `PERSISTENCE_FAILURE`; no durable change | `reputationFaults.test.ts` |
| P3 | Reputation run | per-anchor read failure | healthy anchors still evaluate; failed one reported; partial truth | `reputationFaults.test.ts` |
| P4 | Recovery | rerun after partial score writes | gap filled deterministically; computed-at recorded per anchor | `reputationFaults.test.ts` |
| P5 | Idempotency | repeated reruns | upsert-only; score identity set does not grow | `reputationFaults.test.ts` |
| P6 | Reputation read | deadline exceeded | `EVIDENCE_READ_FAILURE`; no writes | `reputationFaults.test.ts` |
| P7 | Sparse evidence | below-threshold evidence under fault conditions | truthful insufficient-data state persisted; no fabricated score | `reputationFaults.test.ts` |
| O1 | Orchestration | rate + reputation failures combined | rates still precede reputation; `ok=false`; both truths reported | `scheduledCycleFaults.test.ts` |
| O2 | HTTP boundary | fatal reputation error with a secret in the message | safe 500 `internal_error`; secret never serialized | `scheduledCycleFaults.test.ts` |
| O3 | Orchestration | deadline fires mid-rate-phase on virtual clock | partial cycle, not a crash; reputation still runs | `scheduledCycleFaults.test.ts` |
| O4 | HTTP boundary | whole-cycle cancellation at the run seam | safe 500; never a 200 success summary | `scheduledCycleFaults.test.ts` |
| O4b | HTTP boundary | whole-cycle deadline at the run seam | safe 500; never a 200 success summary | `scheduledCycleFaults.test.ts` |
| O5 | Process interruption | process death after one commit, mid-reputation | no summary produced; rerun completes remaining work; no duplicated evidence | `scheduledCycleFaults.test.ts` |
| O6 | Concurrency | overlapping cycles | each summary reports only its own work; no cross-fabrication | `scheduledCycleFaults.test.ts` |
| O7 | HTTP boundary | fault response caching | `Cache-Control: no-store` preserved on fault responses | `scheduledCycleFaults.test.ts` |

## Evidence invariants asserted across scenarios

1. `succeeded` counts only rows that are actually durably present in the
   ledger.
2. Every failure is attributed to a phase (`QUOTE`, `NORMALIZATION`,
   `PERSISTENCE`, `PREPARATION`, `EVIDENCE_READ_FAILURE`,
   `PERSISTENCE_FAILURE`) with a bounded code.
3. Committed evidence survives later failures in the same cycle and across
   reruns.
4. Reruns append only missing evidence; no row is ever duplicated or mutated.
5. Error details (messages, environment values) never reach a run summary or
   HTTP body.

## Running the suite

CI-sized target (runs with the default test suite as well):

```bash
npm run test:faults
```

The fault tests also run as part of the normal suite because they live under
`tests/` and end in `.test.ts`; the dedicated script exists for a focused
run:

```bash
npx tsx --test tests/faults/*.test.ts
```

Extended matrix: new scenarios should follow the same pattern — add a row
here, then a test with the matching `[Rx]`/`[Px]`/`[Ox]` tag in the
appropriate file under `tests/faults/`.
