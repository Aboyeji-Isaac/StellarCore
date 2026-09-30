# Migration Recovery Rehearsal Framework

This document describes the automated rehearsal framework for practicing production migration recovery scenarios. The framework is designed to be run **only against isolated, non-production databases**.

## Overview

The framework (`scripts/migration-rehearsal/`) provides:

1. **Three representative partial-failure scenarios** covering failures before, during, and after schema changes
2. **Automated verification** of intermediate database states
3. **Documented recovery procedures** for each scenario type
4. **Application compatibility checks** against the StellarCore read paths
5. **Migration history verification** using Prisma's migration tracking
6. **Recovery decision records** (JSON artifacts) for each rehearsal run
7. **Hard production guards** that refuse to run against production databases

## Safety First: Production Guards

The framework **will refuse to run** if it detects a production database:

- Hostnames containing `prod`, `production`, `live`, `main`, `primary`
- Cloud provider indicators (`aws`, `gcp`, `azure`, `vercel`, `supabase`, `neon`, `planetscale`)
- Prisma Postgres managed databases with `sslmode=require`

**Never run this against production.** Always use a dedicated rehearsal database (local container, staging, or scratch database).

## Scenarios

### Scenario 1: Migration Fails Before Schema Changes (Idempotent)

**Failure Point:** Before any DDL executes

**State:** Migration record exists in `_prisma_migrations` with `finished_at = NULL` and `applied_steps_count = 0`. No schema changes applied.

**Recovery Strategy:** `rollback` (re-run `prisma migrate deploy`)

**Why Safe:** The migration is idempotent - no DDL has run. Prisma's `migrate deploy` will simply apply the pending migration.

**Verification:**
- Migration record exists with `finished_at = NULL`
- `applied_steps_count = 0`
- No schema objects from the migration exist

**Recovery Steps:**
1. Run `prisma migrate deploy` - applies the pending migration
2. Verify `prisma migrate status` shows "Database schema is up to date!"

### Scenario 2: Migration Fails During Schema Changes (Partial Apply)

**Failure Point:** After some but not all DDL statements execute

**State:** Migration record exists with `applied_steps_count > 0` and `finished_at = NULL`. Some schema objects exist, others don't.

**Recovery Strategy:** `forward-fix` (complete remaining statements) OR `restore-from-backup`

**Decision Criteria:**
- If applied DDL is reversible (e.g., `CREATE INDEX`, `ADD COLUMN` with default): Can rollback by dropping created objects, then re-run
- If applied DDL is NOT easily reversible (e.g., `ALTER TABLE`, data migrations): Forward-fix by completing remaining statements
- If forward-fix fails: Restore from backup

**Verification:**
- Migration record exists with `applied_steps_count > 0`
- `finished_at = NULL`
- Some expected schema objects exist

**Recovery Steps (Forward-Fix):**
1. Apply remaining DDL statements from the migration file (idempotent where possible)
2. Run `prisma migrate deploy` to record completion
3. Verify application compatibility

**Warnings:**
- Manual inspection needed to confirm which statements applied
- If forward-fix fails, restore from backup is required

### Scenario 3: Migration Fails After Schema Changes (Checksum Mismatch)

**Failure Point:** All DDL completed, but `_prisma_migrations` record has wrong checksum

**State:** All schema objects exist correctly. Migration record exists but with incorrect checksum. `prisma migrate status` shows "Database schema is not up to date" or "checksum mismatch".

**Recovery Strategy:** `forward-fix` (repair migration metadata)

**Why This Works:** Schema is correct; only Prisma's metadata is wrong. We can compute the correct checksum from the migration file and update the record.

**Verification:**
- All expected schema objects exist
- Migration record exists but with wrong checksum
- `prisma migrate status` reports mismatch

**Recovery Steps (Metadata Repair):**
1. Compute correct SHA256 checksum from the migration SQL file
2. Update `_prisma_migrations` record with correct checksum
3. Verify `prisma migrate status` shows "Database schema is up to date!"

**Warnings:**
- Only safe when schema is verified correct
- If schema is actually incorrect, this masks the real problem
- If repair fails, restore from backup

## Running Rehearsals

### Prerequisites

1. A **non-production** PostgreSQL database (local container recommended)
2. `DATABASE_URL` environment variable pointing to that database
3. Node.js 22+ with project dependencies installed (`npm ci`)
4. `psql` and `pg_dump`/`pg_restore` in PATH

### Quick Start (Local Container)

```bash
# 1. Start a local Postgres container
docker run -d --name stellarcore-rehearsal \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=stellarcore_rehearsal \
  -p 5433:5432 postgres:16

# 2. Wait for it to be ready, then run initial migration
export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/stellarcore_rehearsal"
npx prisma migrate deploy

# 3. Run the rehearsal (dry-run first)
npx tsx scripts/migration-rehearsal/run.ts --dry-run

# 4. Run live rehearsal
npx tsx scripts/migration-rehearsal/run.ts
```

### Options

```bash
# Run specific scenario only
npx tsx scripts/migration-rehearsal/run.ts --scenario=pre-schema-failure

# Dry run (no database changes)
npx tsx scripts/migration-rehearsal/run.ts --dry-run

# Both
npx tsx scripts/migration-rehearsal/run.ts --scenario=partial-apply-failure --dry-run
```

### Output

Each run creates a timestamped directory under `scripts/migration-rehearsal/reports/`:

```
scripts/migration-rehearsal/reports/
├── pre-schema-failure-2026-09-30T12-00-00.000Z.json
├── partial-apply-failure-2026-09-30T12-05-00.000Z.json
├── post-schema-checksum-mismatch-2026-09-30T12-10-00.000Z.json
└── combined-2026-09-30T12-15-00.000Z.json  # Combined summary
```

## Recovery Decision Records

Each rehearsal produces a **recovery decision record** (JSON) containing:

- Scenario metadata (ID, name, timestamp, database)
- Phase results (setup, failure-injection, verification, recovery, cleanup)
- Migration history before and after
- Recovery decision (strategy, rationale, SQL commands, warnings)
- Compatibility check results
- Migration history verification

These records serve as:
- **Audit trail** of rehearsal execution
- **Runbook reference** for real incidents
- **Regression detection** if scenarios start failing
- **Training artifacts** for on-call engineers

## Application Compatibility Checks

The framework verifies these critical read paths after each recovery:

| Check | Description |
|-------|-------------|
| Migration Status | `prisma migrate status` reports "up to date" |
| Table Existence | All 7 core tables exist |
| Read Path - Latest Rate Per Anchor | Critical `/api/rates` query works |
| Enum Integrity | All 4 enums present and correct |
| Foreign Key Integrity | At least 6 FK constraints exist |

## Migration History Verification

After each recovery, the framework verifies:

1. **Migration count consistency** - Number of applied migrations matches expected
2. **Checksum integrity** - All migration checksums match source files
3. **Applied steps consistency** - `applied_steps_count` matches statement count
4. **No dirty state** - No migrations in "rolled back" or "failed" state

## Integration with Existing Practices

### Backup/Restore (Issue #170, #188)
- Rehearsals use isolated databases (no production data at risk)
- Scenario 2 forward-fix failure falls back to restore procedure
- Restore verification checklist from `docs/backup-and-restore.md` applies

### Migration CI (Issue #112)
- Rehearsals complement CI by testing failure recovery, not just success
- Can be run in CI against ephemeral databases

### Rolling Compatibility (Issue #139)
- Compatibility checks verify application reads work against intermediate states
- Ensures backward-compatible migration patterns

## Adding New Scenarios

1. Create `scripts/migration-rehearsal/scenarios/scenarioN.ts`
2. Export `runScenarioN` function matching the runner interface
3. Add to `SCENARIOS` array in `run.ts`
4. Document in this file

## CI Integration

To run rehearsals in CI (against ephemeral test database):

```yaml
# .github/workflows/migration-rehearsal.yml
name: Migration Recovery Rehearsal

on:
  workflow_dispatch:
  schedule:
    - cron: '0 2 * * 0'  # Weekly

jobs:
  rehearse:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: stellarcore_rehearsal
        ports: ['5432:5432']
        options: >-
          --health-cmd="pg_isready -U postgres"
          --health-interval=10s
          --health-timeout=5s
          --health-retries=5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npx prisma migrate deploy
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/stellarcore_rehearsal
      - run: npx tsx scripts/migration-rehearsal/run.ts
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/stellarcore_rehearsal
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: rehearsal-reports
          path: scripts/migration-rehearsal/reports/
```

## Troubleshooting

| Issue | Resolution |
|-------|------------|
| "SAFETY VIOLATION" | Database URL points to production; use isolated DB |
| `prisma migrate status` fails | Check `DATABASE_URL` is correct and DB is reachable |
| `psql` not found | Install PostgreSQL client tools |
| Scenario 2 partial apply fails | Some DDL may not be idempotent; adjust scenario SQL splitting |
| Checksum mismatch persists | Ensure migration SQL file hasn't been modified |

## References

- `docs/backup-and-restore.md` - Verified backup/restore procedure
- `docs/DEPLOYMENT.md` - Production deployment and rollback guide
- `.github/workflows/deploy-production-migrations.yml` - Production migration workflow
- `.github/workflows/bootstrap-production-registry.yml` - Registry bootstrap workflow