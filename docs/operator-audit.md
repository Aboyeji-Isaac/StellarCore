# Operator audit ledger

StellarCore records privileged administrative actions in one append-only ledger.
An operator action describes StellarCore governance, never an anchor's behavior.

## Truth constraints

- An invalidation is an administrative disposition. It is **not** proof of
  malicious behavior by an anchor or operator.
- Retirement removes an anchor from reviewed configuration. It is **not** a
  claim or observation of external downtime.
- Dispositions never rewrite historical evidence. A `RateSnapshot` row is
  immutable; a disposition only makes a specific snapshot ineligible for the
  latest-rate read model until it is recovered.
- Audit rows never replace or rewrite evidence history.

## Ledger model

`OperatorAction` is append-only and carries:

| Field | Meaning |
| --- | --- |
| `actionId` | Stable, unique action identifier (idempotency key) |
| `actionType` | Typed action from the reviewed vocabulary |
| `mode` | Always `APPLIED`; dry runs never persist a row |
| `targetType` / `targetId` / `targetLabel` | Target identity (rate snapshot or anchor) |
| `reasonCode` | Typed reason from the reviewed vocabulary |
| `rationale` | Bounded, sanitized free text (max 500 characters) |
| `actorType` / `actorId` | Truthful actor: `SYSTEM` with no id, or `HUMAN` with a verified id |
| `runId` | Optional correlation/run identifier |
| `createdAt` | Timestamp |

Immutability is enforced at three layers:

1. The repository interface (`lib/audit/ledgerRepository.ts`) exposes only
   `append` and bounded reads, with no update or delete.
2. Database `CHECK` constraints enforce bounded lengths, `mode = 'APPLIED'`, and
   truthful actor identity (`SYSTEM` has no `actor_id`; `HUMAN` must have one).
3. A `BEFORE UPDATE OR DELETE` (and `BEFORE TRUNCATE`) trigger rejects any
   mutation, including direct SQL.

The ledger never stores tokens, authorization headers, raw payloads, or stack
traces. The input surface has no fields for them, validation rejects control
characters, and all text is bounded.

## Vocabulary

| Action | Target | Allowed reasons |
| --- | --- | --- |
| `RATE_SNAPSHOT_INVALIDATED` | `RATE_SNAPSHOT` | `SOURCE_ERROR`, `DUPLICATE_OBSERVATION`, `STALE_ARTIFACT`, `DATA_CORRECTION`, `OTHER_REVIEWED` |
| `RATE_SNAPSHOT_SUPERSEDED` | `RATE_SNAPSHOT` | `DUPLICATE_OBSERVATION`, `DATA_CORRECTION`, `OTHER_REVIEWED` |
| `RATE_DISPOSITION_RECOVERED` | `RATE_SNAPSHOT` | `OPERATOR_RECOVERY`, `DATA_CORRECTION` |
| `ANCHOR_RETIRED` | `ANCHOR` | `REVIEWED_CONFIGURATION_REMOVAL`, `STALE_ARTIFACT`, `OTHER_REVIEWED` |
| `ANCHOR_REACTIVATED` | `ANCHOR` | `OPERATOR_RECOVERY`, `OTHER_REVIEWED` |

The catalog lives in `lib/audit/vocabulary.ts` and is mirrored by Prisma enums.
Adding an action or reason is a reviewed migration plus a catalog entry.

## Actors

The current runtime authentication boundary (the cron secret, manual jobs) does
not provide a user identity. A system action is recorded as `SYSTEM` with a null
`actor_id`; the layer never invents a human identity. A `HUMAN` action is
recorded only when a trusted boundary supplies an identity. The
`npm run operator:action` CLI is not an authentication boundary: it records
`SYSTEM` unless `--actor-id` is passed explicitly.

## Dry-run and apply

Every operation requires an explicit mode.

- **Dry run** (`--dry-run`, the CLI default) validates the request, resolves the
  target, checks the same preconditions as an apply, and returns a deterministic
  bounded preview. It writes nothing.
- **Apply** (`--apply`) performs the state change and appends exactly one ledger
  row in a single transaction. A failed or rolled-back apply leaves no audit row
  and no state change.

A failed dry run cannot masquerade as an applied action because it never calls
the mutating repository path and no row is written with `mode = 'APPLIED'`.

## Operations

| Operation | State change | Audit action |
| --- | --- | --- |
| Invalidate a rate snapshot | Insert one `RateSnapshotDisposition` | `RATE_SNAPSHOT_INVALIDATED` |
| Supersede a rate snapshot | Insert one `RateSnapshotDisposition` | `RATE_SNAPSHOT_SUPERSEDED` |
| Recover a rate snapshot | Delete the disposition | `RATE_DISPOSITION_RECOVERED` |
| Retire an anchor | Set `lifecycleState = RETIRED` | `ANCHOR_RETIRED` |
| Reactivate an anchor | Set `lifecycleState = ACTIVE` | `ANCHOR_REACTIVATED` |

Atomicity: the disposition/lifecycle repository opens one Prisma transaction that
appends the ledger row **and** applies the state change. The
`RateSnapshotDisposition.actionRecordId` foreign key ties the state row to the
exact audit row, so a state row cannot exist without its audit row and vice versa.
A duplicate `actionId` rolls the whole transaction back.

Retired anchors are hidden from the public anchor/corridor read models, excluded
from the latest-rate read model, and rejected by rate-snapshot persistence with
`ANCHOR_RETIRED`. Historical snapshots remain untouched.

## Commands

```bash
# Read-only inspection (deterministic, bounded, sanitized JSON)
npm run audit:operators
tsx scripts/operator-audit.ts --target-type=RATE_SNAPSHOT --target-id=<uuid> [--limit=50]
tsx scripts/operator-audit.ts --run-id=<id> [--limit=50]

# Administrative operations; dry run by default, add --apply to mutate
npm run operator:action -- invalidate-rate <snapshotId> --reason=SOURCE_ERROR --rationale="reviewed"
npm run operator:action -- supersede-rate   <snapshotId> --reason=DATA_CORRECTION --apply
npm run operator:action -- recover-rate     <snapshotId> --reason=OPERATOR_RECOVERY --apply
npm run operator:action -- retire-anchor    <anchorSlug> --reason=REVIEWED_CONFIGURATION_REMOVAL --apply
npm run operator:action -- reactivate-anchor <anchorSlug> --reason=OPERATOR_RECOVERY --apply
```

Optional flags: `--rationale`, `--run-id`, `--action-id`, `--actor-id`.

## Tests

Unit tests cover the vocabulary, bounded validation, actor truthfulness, preview
determinism, and dry-run/apply semantics. Isolated PostgreSQL tests cover
atomicity, immutability, rollback, actor truthfulness, bounded sanitization, and
read-model integration:

```bash
RUN_OPERATOR_AUDIT_DATABASE_INTEGRATION=1 \
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE" \
npx tsx --test tests/integration/audit/operatorAuditLedger.database.integration.test.ts
```

These tests are skipped by default and must not run against production
credentials or production load.
