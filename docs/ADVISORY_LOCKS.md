# PostgreSQL Advisory Locks Architecture & Namespacing Guide

## Overview

StellarCore uses PostgreSQL advisory locks to coordinate distributed, concurrent, and scheduled workflows across instances without creating table bloat or row-level deadlocks.

To prevent cross-workflow key collisions and version-skew deadlocks during rolling deployments, all advisory locks must follow the deterministic namespaced scheme implemented in [`lib/db/advisoryLock.ts`](../lib/db/advisoryLock.ts).

---

## Key Derivation Scheme

Lock keys are derived deterministically using a SHA-256 hash formatted into signed 64-bit BigInts (`int8`) or a pair of signed 32-bit integers (`int4, int4`):

$$\text{Canonical Name} = \text{"stellarcore:v" + version + ":" + domain + ":" + name}$$

```typescript
const canonicalName = `stellarcore:v${version}:${domain}:${name}`;
const hash = createHash("sha256").update(canonicalName, "utf-8").digest();
const key64 = hash.readBigInt64BE(0);
const classId = hash.readInt32BE(0);
const objId = hash.readInt32BE(4);
```

### PostgreSQL Functions
- **Single 64-bit Key:** `pg_try_advisory_lock(key64)` / `pg_advisory_unlock(key64)`
- **Dual 32-bit Keys:** `pg_try_advisory_lock(classId, objId)` / `pg_advisory_unlock(classId, objId)`

---

## Reserved Domains

| Domain | Description | Typical Workflows |
|---|---|---|
| `REFRESH` | Background data refreshes | Daily indicative rate refresh, reputation re-evaluations |
| `MIGRATION` | Schema & database state transitions | `prisma migrate deploy`, registry bootstrapping |
| `MAINTENANCE` | Privileged operational procedures | Global maintenance mode, isolated restore drills |
| `DISCOVERY` | Anchor and corridor synchronization | Background SEP-1 discovery polling |
| `SNAPSHOT` | High-frequency rate observations | SEP-38 rate snapshot creation |

---

## Declared Locks Registry

All production locks are enumerated in `ADVISORY_LOCK_REGISTRY`:

1. `DAILY_SCHEDULED_REFRESH` (Domain: `REFRESH`)
2. `REPUTATION_REEVALUATION` (Domain: `REFRESH`)
3. `DATABASE_MIGRATION_DEPLOY` (Domain: `MIGRATION`)
4. `REGISTRY_BOOTSTRAP` (Domain: `MIGRATION`)
5. `GLOBAL_MAINTENANCE_GATE` (Domain: `MAINTENANCE`)
6. `ISOLATED_BACKUP_DRILL` (Domain: `MAINTENANCE`)
7. `ANCHOR_SYNC` (Domain: `DISCOVERY`)
8. `CORRIDOR_SYNC` (Domain: `DISCOVERY`)
9. `RATE_SNAPSHOT_OBSERVATION` (Domain: `SNAPSHOT`)

---

## Rolling-Upgrade Compatibility

When lock logic or workflow behavior changes between releases:
1. Increment the `version` field (e.g., from `1` to `2`).
2. The key derivation produces an entirely new cryptographic namespace, preventing an old instance from acquiring a lock that would deadlock a newly deployed canary instance.
3. Once all instances run the new version, the previous version's key is naturally retired.

---

## Operator Diagnostics

In PostgreSQL, active advisory locks can be queried via `pg_locks`:

```sql
SELECT
  pid,
  locktype,
  mode,
  granted,
  objid,
  classid
FROM pg_locks
WHERE locktype = 'advisory';
```

Use `describeAdvisoryLock(key64)` to resolve any numeric lock identifier back to its human-readable logical name and domain without exposing secrets.
