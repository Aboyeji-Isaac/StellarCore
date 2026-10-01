# Advisory Lock Strategy

## Purpose

PostgreSQL session-scoped advisory locks provide a stable, database-backed
coordination primitive for StellarCore workflows. This document is the
authoritative registry of every declared lock name, its domain, its versioning
rule, and its derived key. Issue #111 owns wiring this primitive into the
scheduled-refresh run ledger; this issue defines the lock identity contract that
#111 and future privileged workflows must consume.

---

## Key Derivation Formula

```
logical_name  =  <domain>:<workflow>:<version>:<resource>
derived_key   =  fnv1a_64(logical_name), reinterpreted as PostgreSQL bigint
```

`fnv1a_64` is FNV-1a 64-bit applied over each UTF-16 code unit of the logical
name. Registered lock names are restricted by convention to stable ASCII
segments, so this derivation is deterministic across supported Node 22
environments. The result is reinterpreted as a signed PostgreSQL `int8`.
The implementation is in `lib/scheduled/advisoryLockKey.ts`.

The domain segment is embedded in the logical name. It does **not** occupy
dedicated bits of the key; isolation comes from the distinct logical name.

---

## Reserved Domain IDs

Numeric domain IDs are documentation anchors used in the registry and collision
tests. They do **not** appear in the key derivation itself.

| Domain ID | Domain String | Purpose |
|:--:|--|--|
| `0x01` | `refresh` | Scheduled rate + reputation refresh |
| `0x02` | `migration` | Schema migration serialization |
| `0x03` | `maintenance` | Operator maintenance tasks |
| `0x04` | `future_04` | Reserved — unassigned |
| `0x05` | `future_05` | Reserved — unassigned |

---

## Lock Registry

All declared lock identities are listed below. Some entries are reserved for
workflows that will consume the shared lock layer as their implementation lands.
A collision test fails if any two declared names derive to the same key.

| Logical Name | Domain ID | Description | Derived Key |
|--|:--:|--|--:|
| `refresh:scheduled-refresh:v1:global` | `0x01` | Scheduled-refresh exclusion identity | `432775748742422739` |
| `migration:schema-migration:v1:global` | `0x02` | Reserved schema-migration identity | `5712893717979117713` |
| `maintenance:registry-bootstrap:v1:global` | `0x03` | Reserved registry-bootstrap identity | `5844646091915520822` |
| `maintenance:reputation-backfill:v1:global` | `0x03` | Reserved reputation-backfill identity | `-2974118469127250590` |

---

## Versioning Rules

- A deployed logical lock name is **stable**.
- Keep the same version when old and new application versions must remain
  mutually exclusive during a rolling deployment.
- A version bump (`v1` → `v2`) intentionally creates a **different advisory
  lock key**. It is safe only when the old and new workflows are explicitly
  allowed to run concurrently, or when rollout orchestration guarantees the old
  version has drained before the new identity is used.
- Never use a version bump as a deadlock fix by itself. Separate keys remove
  coordination; they do not preserve mutual exclusion.
- Do not silently change an existing `logicalName`. Add a reviewed new
  descriptor when a new identity is actually required.

---

## Rolling Deployment Safety

PostgreSQL `pg_try_advisory_lock` is non-blocking:

1. When old and new nodes use the **same logical name/version**, they contend on
   the same key. One acquires it and the other receives `already_held`; neither
   waits on the other, so the lock path cannot create a blocking deadlock.
2. When a reviewed version bump uses a **different key**, both versions may
   acquire their keys at the same time. This is namespace separation, not mutual
   exclusion, and therefore requires an explicit coexistence/drain decision.
3. `pg_advisory_unlock` is attempted only after this helper acquired the lock.
   A lost PostgreSQL session releases its session-scoped advisory locks
   automatically.

The database integration test exercises real PostgreSQL contention with two
independent sessions and verifies that the second same-key attempt fails fast.
It also demonstrates the intentionally independent behavior of versioned keys.

---

## Adding a New Lock

1. Choose an existing domain or propose a reviewed new domain ID.
2. Compose `<domain>:<workflow>:<version>:<resource>`.
3. Add the descriptor to `LOCK_REGISTRY`.
4. Run the unit collision tests and the opt-in PostgreSQL advisory-lock
   integration test.
5. Update this document in the same change.
6. Wire production callers to the registry descriptor rather than deriving
   ad-hoc strings.

---

## Operator Diagnostics

Raw `bigint` keys from PostgreSQL's `pg_locks` view can be reverse-mapped
with `diagnoseLockKey` and `listRegisteredLocks`. Diagnostics contain only
the numeric key, logical name, domain ID, and static description; they do not
include payloads, environment variables, database URLs, or credentials.

---

## Verification

Unit coverage lives under `tests/unit/scheduled/`. Real PostgreSQL behavior is
covered by `tests/integration/scheduled/advisoryLock.database.integration.test.ts`.
The database test is opt-in and runs only when `RUN_DATABASE_INTEGRATION=1`
and `DATABASE_URL` are provided.
