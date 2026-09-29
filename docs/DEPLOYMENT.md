# Production deployment

StellarCore is prepared for a Vercel deployment backed by managed PostgreSQL and Prisma ORM. This guide prepares deployment only; it does not provision or modify hosted services.

## Architecture

- Next.js 15 App Router deploys as Vercel Node.js functions.
- Prisma Client uses the `PrismaPg` adapter with two server-only PostgreSQL connections: `DATABASE_READ_URL` (public reads, `lib/db/readClient.ts`) and `DATABASE_WRITE_URL` (internal mutations, `lib/db/writeClient.ts`). See [Database roles](#database-roles).
- Public API routes and the dashboard are read-only and connect as the read role. The refresh route is a Node.js-only, authenticated internal mutation boundary that connects as the writer.
- Vercel Cron invokes only `/api/internal/cron/refresh` on production deployments.

## Environment

| Name | Production | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_READ_URL` | Required (Vercel runtime) | Yes | Public read-only role. Used by public API routes and dashboard repositories. |
| `DATABASE_WRITE_URL` | Required (Vercel runtime; GitHub `production` environment for bootstrap) | Yes | Internal writer role. Used by the scheduled refresh, registry bootstrap, and rate/reputation persistence. |
| `MIGRATION_DATABASE_URL` | GitHub `production` environment only | Yes | Migration owner. Used only by `prisma migrate deploy` and `npm run db:grants`. **Never** configure it on Vercel. |
| `DATABASE_READ_ROLE` / `DATABASE_WRITE_ROLE` | Optional (GitHub environment variables) | No | Runtime role names for `npm run db:grants`; default `stellarcore_reader` / `stellarcore_writer`. |
| `CRON_SECRET` | Required when cron is enabled | Yes | Bearer secret Vercel sends to the refresh route. |

Every URL must be a `postgres://` or `postgresql://` URL. Do not expose any of them through `NEXT_PUBLIC_*`, repository files, or logs. The runtime has no fallback between them: a missing `DATABASE_READ_URL` fails closed rather than using the writer, and in production the runtime refuses to connect when `MIGRATION_DATABASE_URL` or the legacy `DATABASE_URL` is present, or when the read and write URLs use the same database user. Configuration errors name only the variable, never its value.

## Database roles

StellarCore separates three PostgreSQL privilege classes. The database, not an application convention, enforces the boundaries; `tests/integration/database/roles.database.integration.test.ts` proves them against a real PostgreSQL server (see [testing-guide.md](testing-guide.md#database-role-tests)).

| Class | Credential | May | Must not |
| --- | --- | --- | --- |
| Migration owner (e.g. `stellarcore_owner`) | `MIGRATION_DATABASE_URL` | Own the application schema and every table; run migrations; apply grants | Be configured for the deployed runtime |
| Internal writer (`stellarcore_writer`) | `DATABASE_WRITE_URL` | `SELECT` application tables; the reviewed DML in `lib/db/grants.ts` (`WRITER_TABLE_PRIVILEGES`) | Own objects; `CREATE`/`ALTER`/`DROP`/`TRUNCATE`; update or delete `rate_snapshots`; write `transfer_outcomes`; read `_prisma_migrations` |
| Public reader (`stellarcore_reader`) | `DATABASE_READ_URL` | `SELECT` application tables | Any DML, `TRUNCATE`, or DDL |

The reviewed writer matrix is:

| Table | Writer privileges beyond `SELECT` | Approved path |
| --- | --- | --- |
| `anchors` | `INSERT`, `UPDATE` | `lib/stellar/anchorSync.ts` |
| `corridors` | `INSERT`, `UPDATE` | `lib/stellar/corridorSync.ts` |
| `anchor_corridors` | `INSERT`, `DELETE` | `lib/stellar/corridorSync.ts` (association reconciliation) |
| `rate_snapshots` | `INSERT` (append-only) | `lib/rates/snapshot.ts` |
| `reputation_scores` | `INSERT`, `UPDATE` | `lib/reputation/repository.ts` |
| `transfer_outcomes` | none | no writer path yet |

`npm run db:grants` applies this plan as the migration owner in one transaction. It is idempotent: it revokes both runtime roles' privileges on each application table and sequence, re-grants exactly the matrix, revokes `CREATE` on the `public` schema from `PUBLIC`, and sets default privileges so tables that later migrations create are `SELECT`-only for both runtime roles (sequences: `USAGE, SELECT` for the writer). A new table gets writer DML only after the matrix is updated in review and the plan is re-applied. The command reads no evidence rows and never rewrites them. It exits nonzero, printing only a bounded code, when a runtime role is missing, has `SUPERUSER`/`CREATEROLE`/`CREATEDB`/`REPLICATION`/`BYPASSRLS`, is or inherits the owner, owns schema objects, or when migrations have not yet created the application tables. `npm run db:grants -- --print` prints the plan for review without connecting.

Code boundaries mirror the roles. Public repositories import `@/lib/db/readClient`, whose type removes Prisma mutation methods. Only the approved mutation paths listed in `eslint.config.mjs` (`APPROVED_WRITER_IMPORTERS`) may import `@/lib/db/writeClient`. `npm run lint` rejects any other static, dynamic, or re-exported writer import, and `tests/unit/db/importBoundaries.test.ts` fails if the writer becomes reachable from any public route, page, or component, even indirectly.

A successful permission check proves only that an operation was authorized. It does not validate quote accuracy, source independence, transfer outcomes, or reputation.

### One-time role setup

A database administrator creates the roles outside the repository. Generate each password with a secret manager and never commit it. Portable SQL, run as an administrator:

```sql
CREATE ROLE stellarcore_owner  LOGIN PASSWORD '<from secret manager>';
CREATE ROLE stellarcore_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<from secret manager>';
CREATE ROLE stellarcore_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<from secret manager>';
-- The owner must own the application schema so default privileges cover
-- every object future migrations create.
ALTER SCHEMA public OWNER TO stellarcore_owner;
```

Do not grant the runtime roles membership in the owner, and do not `GRANT` anything to them by hand; `npm run db:grants` manages their privileges.

### Bootstrap order for a new database

1. Create the three roles (above).
2. Store `MIGRATION_DATABASE_URL` and `DATABASE_WRITE_URL` as GitHub `production` environment secrets. Store `DATABASE_READ_URL`, `DATABASE_WRITE_URL`, and `CRON_SECRET` in the Vercel production environment. Make sure Vercel has no `DATABASE_URL` or `MIGRATION_DATABASE_URL`.
3. Run **Deploy production migrations**. It applies migrations as the owner, then runs `npm run db:grants`.
4. Run **Bootstrap production registry**. It runs as the writer.
5. Deploy the application.

### Migrating an existing single-credential deployment

The existing database keeps all its rows; only ownership and privileges change. Take a backup first (see [backup-and-restore.md](backup-and-restore.md)).

1. Disable the Vercel cron.
2. Create the reader and writer roles. If the existing `DATABASE_URL` user owns the tables, keep it as the migration owner; otherwise, as an administrator, run `REASSIGN OWNED BY <old user> TO stellarcore_owner` in the application database, which transfers ownership without touching rows.
3. Rename the GitHub `production` secret `DATABASE_URL` to `MIGRATION_DATABASE_URL` (same value when the old user is the owner), and add `DATABASE_WRITE_URL`.
4. Run **Deploy production migrations** (it applies the grants even when no migration is pending) and confirm the grants step prints `"ok": true`.
5. In Vercel, set `DATABASE_READ_URL` and `DATABASE_WRITE_URL` and **delete** `DATABASE_URL`; redeploy. A production runtime with `DATABASE_URL` still present refuses to connect.
6. Verify the public routes (see [First production cycle](#first-production-cycle)) and re-enable the cron.

### Credential rotation

Rotate one role at a time, so the other paths keep working:

1. `ALTER ROLE stellarcore_reader PASSWORD '<new, from secret manager>';` (or the writer/owner).
2. Update the matching secret: Vercel `DATABASE_READ_URL` or `DATABASE_WRITE_URL` (then redeploy), the GitHub `DATABASE_WRITE_URL`, or the GitHub `MIGRATION_DATABASE_URL`.
3. Verify the affected path: public routes for the reader, the next cron or a manual bootstrap for the writer, a no-op **Deploy production migrations** run for the owner.

For zero-downtime rotation, create a second login role (for example `stellarcore_reader_2`), give it the same privileges by running `npm run db:grants` with `DATABASE_READ_ROLE=stellarcore_reader_2`, switch the URL, then drop the old role. Password changes do not affect grants.

### Failure recovery

| Symptom | Cause | Recovery |
| --- | --- | --- |
| Public routes return `500 internal_error`; logs show `DATABASE_URL_MISSING` | `DATABASE_READ_URL` or `DATABASE_WRITE_URL` unset | Set the variable in Vercel and redeploy. There is deliberately no fallback. |
| Logs show `DATABASE_PRIVILEGED_URL_IN_RUNTIME` | `MIGRATION_DATABASE_URL` or legacy `DATABASE_URL` present in the runtime | Remove it from Vercel and redeploy. |
| Logs show `DATABASE_ROLES_NOT_SEPARATED` | Read and write URLs use the same user | Point each URL at its own role. |
| Refresh or bootstrap fails with `permission denied` after a migration | New table lacks writer DML, or grants were not re-applied | Add the table to `WRITER_TABLE_PRIVILEGES` in review, then re-run **Deploy production migrations**. |
| Grants step fails with `APPLICATION_TABLES_MISSING` | Grants ran before migrations | Apply migrations first; the workflow runs them in order. |
| Grants step fails with `RUNTIME_ROLE_OWNS_OBJECTS`, `RUNTIME_ROLE_PRIVILEGED`, or `RUNTIME_ROLE_INHERITS_OWNER` | Role setup drift | As an administrator, `REASSIGN OWNED BY <runtime role> TO stellarcore_owner`, strip elevated attributes, or revoke owner membership; then re-run. |

### Provider caveats

The grant plan uses only standard PostgreSQL statements, but providers differ in who may create roles and own schemas:

- **Vercel / Prisma Postgres and other managed services** may issue a single generated credential without role management. Least-privilege roles require a plan or provider that allows `CREATE ROLE`; without it the runtime still separates connections, but the database-level guarantees above do not hold until the roles exist.
- **Supabase** and similar platforms pre-create roles and may keep `public` owned by `postgres`. Use `postgres` (or a dedicated owner given ownership of `public`) as the migration owner, and create the reader and writer roles through SQL rather than the platform's API roles.
- **Connection poolers** (PgBouncer in transaction mode) do not change privileges, but the migration owner must use a direct, non-pooled URL.
- **PostgreSQL 14 and earlier** grant `CREATE` on `public` to `PUBLIC` by default; `db:grants` revokes it, which requires the owner to own `public`.
- `TEMPORARY` on the database stays granted to `PUBLIC` by default, so runtime roles can create session-local temporary tables but no application objects. Revoke it with `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC` if nothing else using the database needs it.

## Migration strategy

1. Configure the server-only runtime `DATABASE_READ_URL` and `DATABASE_WRITE_URL` for the production deployment, and separately configure the protected GitHub Actions `production` environment's migration owner credential as its `MIGRATION_DATABASE_URL` secret.
2. From a protected CI/release step, run `npx prisma migrate deploy` once against that environment, followed by `npm run db:grants`.
3. Confirm `npx prisma migrate status` is current.
4. Deploy the application with `npm run build`.

Do not run `prisma migrate dev`, `prisma db push`, reset commands, or `migrate deploy` from ordinary Vercel builds. Keeping migrations outside the build prevents preview deployments from mutating a shared production database.

## Production migration workflow (GitHub Actions)

The protected step above is implemented as a manual GitHub Actions workflow:
`.github/workflows/deploy-production-migrations.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, so a
preview or an ordinary build can never mutate the production database. It runs
`npx prisma migrate deploy` and then `npm run db:grants` on `ubuntu-latest` with Node.js 22 after
`npm ci`, uses least-privilege `contents: read` permissions, a 10-minute job
timeout, and a non-cancelling `production-database-migration` concurrency group
so two migration runs can never overlap.

The `production` environment's `MIGRATION_DATABASE_URL` secret is supplied
only to the migration and grant steps. `npm ci` runs the `postinstall` script
(`prisma generate`), which needs no database credential, so dependency
installation never sees the secret. It is never printed.

One-time setup (repository admin):

1. Open the GitHub repository **Settings**.
2. Under **Environments**, create a GitHub Actions environment named
   `production`.
3. In that environment, add an environment secret named
   `MIGRATION_DATABASE_URL`.
4. Set it to the migration owner's **direct** PostgreSQL connection string (a
   `postgres://` / `postgresql://` URL, not a pooled/PgBouncer endpoint). Do
   not put this value in any repository file or in Vercel. Optionally add
   `DATABASE_READ_ROLE` / `DATABASE_WRITE_ROLE` environment *variables* when
   the runtime role names differ from the defaults.
5. Optionally add **required reviewers** and other environment protection rules
   to `production` so a human must approve each migration run.

Running a migration:

6. Open the repository **Actions** tab.
7. Select the **Deploy production migrations** workflow.
8. Choose **Run workflow** on the intended branch and confirm.
9. Confirm the **Apply migrations** step succeeds (the run log shows the
   applied migrations, or "No pending migrations to apply") and the **Apply
   database role grants** step prints `"ok": true`.
10. Only then continue to the **Bootstrap production registry** workflow
    (see below) and the application deployment described below.

The workflow never prints the secret and adds no environment-dumping debug
steps. `MIGRATION_DATABASE_URL` is the only secret it consumes; it does not
use the Vercel CLI, Vercel tokens, `CRON_SECRET`, the runtime role URLs,
`POSTGRES_URL`, or `PRISMA_DATABASE_URL`.

## Preview policy

Preview deployments must not receive the production `DATABASE_READ_URL`, `DATABASE_WRITE_URL`, or `CRON_SECRET`. Until isolated preview database infrastructure exists, omit database secrets from previews; database-backed routes will fail safely rather than target production.

## Bootstrap

After migrations, run the explicit, idempotent command once in the protected production job environment:

```bash
npm run bootstrap:registry
```

It uses the existing reviewed registries and synchronization logic to discover/upsert anchors, upsert corridors, and reconcile associations. It prints safe structured results and exits nonzero for failures. It is never called by a web request, build, or cron route.

## Production registry bootstrap workflow (GitHub Actions)

The bootstrap above is also implemented as a manual GitHub Actions workflow:
`.github/workflows/bootstrap-production-registry.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, preview
deployments, the migration workflow, and the scheduled refresh, so none of
those can mutate the production registry. It runs exactly
`npm run bootstrap:registry` on `ubuntu-latest` with Node.js 22 after `npm ci`,
uses least-privilege `contents: read` permissions, a 10-minute job timeout, and
a non-cancelling `production-registry-bootstrap` concurrency group so two
bootstrap runs can never overlap.

The bootstrap is manual and idempotent. It is normally required once for a
fresh production database, immediately after migrations and before the first
scheduled refresh. It may also be re-run deliberately after a reviewed change
to the anchor/corridor registry in the repository; re-running upserts the
current reviewed registry and reconciles associations without creating
duplicates. It creates no new anchors, infers no corridors, and never resets
data; it exits nonzero on any synchronization failure.

The `production` environment's `DATABASE_WRITE_URL` secret is supplied only to
the bootstrap step, which runs as the internal writer and never with the
migration owner credential. Dependency installation needs no database
credential. The secret is never printed. `DATABASE_WRITE_URL` is the only
secret the workflow consumes; it does not use the Vercel CLI, Vercel tokens,
`CRON_SECRET`, `MIGRATION_DATABASE_URL`, `POSTGRES_URL`, or
`PRISMA_DATABASE_URL`.

Running the bootstrap:

1. Confirm the **Deploy production migrations** workflow has completed
   successfully (including its grants step) and the `production` environment's
   `DATABASE_WRITE_URL` secret is in place.
2. Open the repository **Actions** tab.
3. Select the **Bootstrap production registry** workflow.
4. Choose **Run workflow** on the intended branch and confirm.
5. Confirm the **Bootstrap registry** step succeeds; the run log prints a safe
   structured JSON summary of anchor and corridor synchronization. A nonzero
   exit means at least one entry failed to synchronize — resolve it and
   re-run.
6. Only then continue to the application deployment and scheduled refresh
   described below.

## Scheduler

`vercel.json` schedules the single production-only refresh route once daily at `0 0 * * *` (midnight UTC), which is compatible with the Vercel Hobby plan. Vercel sends `CRON_SECRET` as a Bearer authorization header; the route uses constant-time validation, accepts GET only, returns bounded no-store JSON, and does not accept query-string credentials.

The locally verified run took about ten seconds. At the current reviewed scope of one rate source and three anchors, one Node.js function invocation is acceptable; this is a production observation, not an architectural limit. Add a distributed lock, chunking, or workers before the source/anchor set grows materially; Vercel does not retry failed cron invocations automatically.

## First production cycle

1. Apply committed migrations with the **Deploy production migrations**
   workflow (`.github/workflows/deploy-production-migrations.yml`).
2. Synchronize the reviewed registry with the **Bootstrap production registry**
   workflow (`.github/workflows/bootstrap-production-registry.yml`) and resolve
   any nonzero result.
3. Deploy or redeploy the Vercel application with `npm run build` as the build command.
4. Let the scheduled refresh ingest indicative rates, then evaluate the currently sparse reputation evidence. It does not ingest transfer outcomes.
5. Verify `GET /api/anchors`, `/api/corridors`, `/api/rates?corridor=usdc-us-brl-br`, `/api/reputation`, and `/api/reputation/zeam`.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.
