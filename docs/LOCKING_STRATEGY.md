# Advisory Lock Strategy

## Purpose

PostgreSQL session-scoped advisory locks prevent concurrent StellarCore
scheduler invocations from executing overlapping work. This document is the
authoritative registry of every declared lock name, its domain, its versioning
rule, and its derived key. Any change to a logical name is a breaking change
requiring a new version segment; this document must be updated in the same
commit.

---

## Key Derivation Formula

```
logical_name  =  <domain>:<workflow>:<version>:<resource>
derived_key   =  fnv1a_64(logical_name), reinterpreted as PostgreSQL bigint
```

`fnv1a_64` is FNV-1a 64-bit applied over each UTF-16 code unit of the logical
name. The result is an unsigned 64-bit integer reinterpreted as a signed `int8`
(two's-complement) so it fits `pg_advisory_lock(bigint)`. The implementation is
in `lib/scheduled/advisoryLockKey.ts`.

The domain segment is a short lowercase string embedded in the logical name. It
does **not** occupy dedicated bits of the key; isolation comes from the distinct
logical name, not from bit-range partitioning.

---

## Reserved Domain IDs

Numeric domain IDs are documentation anchors used in the registry and collision
tests. They do **not** appear in the key derivation itself.

| Domain ID | Domain String  | Purpose                                  |
|:---------:|----------------|------------------------------------------|
| `0x01`    | `refresh`      | Scheduled rate + reputation refresh      |
| `0x02`    | `migration`    | Schema migration serialization           |
| `0x03`    | `maintenance`  | Operator maintenance tasks               |
| `0x04`    | `future_04`    | Reserved — unassigned                    |
| `0x05`    | `future_05`    | Reserved — unassigned                    |

---

## Lock Registry

All declared locks are listed below. The `Derived Key` column is the exact
signed `bigint` value passed to `pg_advisory_lock`. A collision test in
`tests/unit/scheduled/advisoryLockKey.test.ts` fails the build if any two
logical names produce the same derived key.

| Logical Name                                     | Domain ID | Description                                         | Derived Key              |
|--------------------------------------------------|:---------:|-----------------------------------------------------|-------------------------:|
| `refresh:scheduled-refresh:v1:global`            | `0x01`    | Prevents concurrent scheduled-refresh cycles        | `432775748742422739`     |
| `migration:schema-migration:v1:global`           | `0x02`    | Serializes manual schema migration runs             | `5712893717979117713`    |
| `maintenance:registry-bootstrap:v1:global`       | `0x03`    | Serializes registry bootstrap across invocations    | `5844646091915520822`    |
| `maintenance:reputation-backfill:v1:global`      | `0x03`    | Serializes one-off reputation backfill operations   | `-2974118469127250590`   |

---

## Versioning Rules

- Logical name segments are **stable after first deployment**.
- A behavior change that must not coexist with the old lock path requires a new
  version segment: `v1` → `v2`. The old `v1` descriptor remains in the registry
  until no node in a rolling deployment can possibly hold it.
- Do **not** change an existing `logicalName` in place. Add a new descriptor and
  remove the old one only after every node has drained.

---

## Rolling Deployment Safety (vN → vN+1)

During a rolling deployment where some nodes run `vN` and others `vN+1`:

1. If the lock's logical name is **unchanged**, both versions attempt the same
   key. The first node to acquire it proceeds; the second gets `already_held`
   and returns a non-error `already_running` result. No deadlock is possible
   because `pg_try_advisory_lock` is non-blocking.
2. If the lock's logical name **changed** (version bump), `vN` and `vN+1` nodes
   hold different keys concurrently. Both proceeds without interference. The
   operator must ensure both code paths are safe to run in parallel for the
   duration of the rollout window.
3. `pg_advisory_unlock` is called in a `finally` block; a dropped database
   connection releases the session lock automatically, preventing stale lock
   accumulation across restarts.

---

## Adding a New Lock

1. Choose the domain string from the table above, or propose a new domain with a
   new numeric ID.
2. Compose the logical name: `<domain>:<workflow>:<version>:<resource>`.
3. Add a `descriptor(...)` call to `LOCK_REGISTRY` in
   `lib/scheduled/advisoryLockKey.ts`.
4. Run `npm test` — the collision test will fail immediately if the new key
   collides with an existing one.
5. Update this document with the new row.
6. Commit both the code and documentation changes together.

---

## Operator Diagnostics

Raw `bigint` keys seen in PostgreSQL's `pg_locks` view can be reverse-mapped
to their logical names using the diagnostic utilities in
`lib/scheduled/lockDiagnostics.ts`:

```typescript
import { diagnoseLockKey, listRegisteredLocks } from "@/lib/scheduled/lockDiagnostics";

// Reverse-map a single raw key
diagnoseLockKey(432775748742422739n);
// → { key: "432775748742422739", logicalName: "refresh:scheduled-refresh:v1:global", domainId: 1, description: "..." }

// Print the full registry
listRegisteredLocks();
// → [{ key, logicalName, domainId, description }, ...]
```

These functions never expose payload data, environment variables, or database
credentials. They are safe to call in log lines, health endpoints, and metrics
exporters.

---

## Implementation Files

| File                                        | Role                                                         |
|---------------------------------------------|--------------------------------------------------------------|
| `lib/scheduled/advisoryLockKey.ts`          | FNV-1a key derivation, domain constants, LOCK_REGISTRY       |
| `lib/scheduled/advisoryLockClient.ts`       | `withAdvisoryLock`, `describeLockKey`, injectable pool deps  |
| `lib/scheduled/lockDiagnostics.ts`          | `diagnoseLockKey`, `listRegisteredLocks` operator utilities  |
| `tests/unit/scheduled/advisoryLockKey.test.ts`     | Collision test, determinism, domain isolation, registry     |
| `tests/unit/scheduled/advisoryLockClient.test.ts`  | Acquire/skip/release, body execution, error propagation     |
| `tests/unit/scheduled/lockDiagnostics.test.ts`     | Reverse-map, unknown keys, registry listing                 |
| `tests/unit/scheduled/lockVersionSafety.test.ts`   | Rolling deployment vN→vN+1 key isolation                   |
