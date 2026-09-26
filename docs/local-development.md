# Local development workflows

For the initial clone, environment setup, migrations, and the development
server, follow [README.md — Getting Started](../README.md#getting-started).
This page documents the individual maintenance commands so they can be run
and debugged independently without repeating that setup guide.

## Run one workflow at a time

After migrations have been applied and `.env.local` contains a local
`DATABASE_URL`, run the jobs directly from the repository root:

```bash
# Synchronize the reviewed anchor and corridor registries.
# This is the current equivalent of the old “sync anchors” wording.
npm run bootstrap:registry

# Fetch reviewed live SEP-38 rates and persist snapshots.
npm run snapshot:rates

# Recompute reputation rows for the configured reviewed anchors.
# This is the current equivalent of the old “compute reputation” wording.
npm run verify:reputation

# Read-only checks that are useful after either write-oriented job.
npm run verify:latest-rates
npm run registry:print
```

Each command has its own entry point under `scripts/` and exits non-zero when
its work reports a failure. `bootstrap:registry` writes the reviewed anchor,
corridor, and relationship records; `snapshot:rates` calls the configured
SEP-38 sources and stores successful snapshots; and `verify:reputation`
recomputes reputation rows from persisted data. Run them against a disposable
local database when experimenting.

## Seed useful local scenarios

The reviewed registry is seeded through the same idempotent command used by
the documented deployment workflow:

```bash
npx prisma migrate dev
npm run bootstrap:registry
```

For a clean experiment, point `DATABASE_URL` at a disposable PostgreSQL
database and run migrations before bootstrapping. Do not copy production
credentials into `.env.local`. The rate snapshot and reputation jobs operate
on the rows already present in that database, so run the bootstrap first when
you need the reviewed anchors and corridors.

## Run or debug one test file

Run a focused file without starting Next.js:

```bash
npx tsx --test tests/unit/stellar/sep38.test.ts
npx tsx --test --test-name-pattern="timeout" tests/unit/stellar/sep38.test.ts
```

To pause before the selected tests execute, use Node's inspector:

```bash
node --inspect-brk --import tsx --test tests/unit/stellar/sep38.test.ts
```

The default suite is `npm test`; see the [testing guide](testing-guide.md) for
test layout, naming, and network-mocking conventions.
