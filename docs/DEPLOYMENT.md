# Production deployment

StellarCore is prepared for a Vercel deployment backed by managed PostgreSQL and Prisma ORM. This guide prepares deployment only; it does not provision or modify hosted services.

## Architecture

- Next.js 15 App Router deploys as Vercel Node.js functions.
- Prisma Client uses the `PrismaPg` adapter with a server-only PostgreSQL connection supplied as `DATABASE_URL` for the running environment.
- Public API routes are read-only. The refresh route is a Node.js-only, authenticated internal mutation boundary.
- Vercel Cron invokes only `/api/internal/cron/refresh` on production deployments.

## Environment

| Name | Production | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | Yes | Server-only PostgreSQL connection appropriate to the running environment. The protected migration workflow separately configures its direct Prisma Postgres credential under this secret name. |
| `CRON_SECRET` | Required when cron is enabled | Yes | Bearer secret Vercel sends to the refresh route. |
| `PRODUCTION_DATABASE_EXPECTED_FINGERPRINT` | Optional | No | Narrows the approved production cluster fingerprint to exactly one during a rotation window. Rejected if it is not already on the reviewed list. |
| `PRODUCTION_DATABASE_EXPECTED_MARKER` | Optional | No | Requires one exact non-secret production marker. Rejected if it disagrees with the reviewed marker. |

`DATABASE_URL` must be a `postgres://` or `postgresql://` URL. The application runtime uses the credential configured for its deployment environment. The protected GitHub Actions production environment separately stores the direct Prisma Postgres credential used by `prisma migrate deploy` under the same `DATABASE_URL` secret name. Do not expose either credential through `NEXT_PUBLIC_*`, repository files, or logs.

The two optional `PRODUCTION_DATABASE_*` variables are not secrets. They can only narrow the reviewed production target identity, never widen it, so a wrong value fails closed. See [production-database-identity.md](production-database-identity.md).

## Production database identity

Both privileged workflows — this migration and the registry bootstrap below — run a read-only preflight before they mutate anything:

```bash
npm run preflight:production-database
```

The preflight opens a dedicated connection, opens a `BEGIN TRANSACTION READ ONLY` transaction, and compares what the server reports about itself against the reviewed target identity in `constants/productionDatabaseIdentity.ts`. It requires three things to agree:

1. the connection URL's host, port, and database name match the reviewed target;
2. `current_database()`, `inet_server_addr()`, and `inet_server_port()` hash to a fingerprint on the reviewed approved list;
3. the non-secret marker row written by a committed migration matches the reviewed marker.

A mismatch in any of them exits nonzero and fails the job, which skips the migration or bootstrap step. There is no override flag and no warn-and-continue path. The preflight writes nothing, and its output is a single line of JSON whose type cannot represent a password, a username, or a connection string — a driver error that embeds the DSN is collapsed to a single code rather than forwarded.

The expected identity is **not** a secret and is **not** stored in GitHub. It is a reviewed repository file, gated by CODEOWNERS and validated offline by `npm run audit:config`. Planning a database replacement is therefore a pull request against that file, never an environment edit.

The fingerprint depends on the server's own network address, so the production credential must be a **direct** connection rather than a pooled or proxying endpoint; a socket or proxying endpoint halts with `PRODUCTION_DATABASE_FINGERPRINT_UNVERIFIED`. The same direct-connection requirement already applies to `prisma migrate deploy`.

The full identity model, the provisioning path for a new database, the rotation procedure with its overlap window, and the limits of what the guard claims are in [production-database-identity.md](production-database-identity.md).

## Migration strategy

1. Configure the server-only runtime `DATABASE_URL` for the production deployment, and separately configure the protected GitHub Actions `production` environment's direct Prisma Postgres credential as its `DATABASE_URL` secret.
2. Review the production target identity in `constants/productionDatabaseIdentity.ts` so the preflight has an approved host, cluster fingerprint, and marker to enforce.
3. From a protected CI/release step, run the preflight and then `npx prisma migrate deploy` once against that environment.
4. Confirm `npx prisma migrate status` is current.
5. Deploy the application with `npm run build`.

Do not run `prisma migrate dev`, `prisma db push`, reset commands, or `migrate deploy` from ordinary Vercel builds. Keeping migrations outside the build prevents preview deployments from mutating a shared production database.

## Production migration workflow (GitHub Actions)

The protected step above is implemented as a manual GitHub Actions workflow:
`.github/workflows/deploy-production-migrations.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, so a
preview or an ordinary build can never mutate the production database. It runs
the read-only target-identity preflight and then exactly
`npx prisma migrate deploy` on `ubuntu-latest` with Node.js 22 after
`npm ci`, uses least-privilege `contents: read` permissions, a 10-minute job
timeout, and a non-cancelling `production-database-migration` concurrency group
so two migration runs can never overlap.

The **Apply migrations** step is explicitly gated on `if: ${{ success() }}`. That
is the default in GitHub Actions, but it is written out so the preflight stays a
hard gate on the mutation: a later edit cannot reorder, duplicate, or
conditionally skip the preflight and silently turn the guard back into advice.
`tests/unit/config/productionDatabaseWorkflows.test.ts` asserts this ordering and
this gate, along with the continued absence of any database-destroying command.

The `production` environment's `DATABASE_URL` secret is supplied to the
dependency-installation step, the preflight step, and the migration step. `npm ci` runs the
`postinstall` script (`prisma generate`), which loads `prisma.config.ts`, and
that configuration resolves `DATABASE_URL`; without the secret the install step
fails with `PrismaConfigEnvError: Cannot resolve environment variable:
DATABASE_URL` before any migration runs. The secret stays scoped to those steps rather than
the whole workflow, and is never printed.

One-time setup (repository admin):

1. Open the GitHub repository **Settings**.
2. Under **Environments**, create a GitHub Actions environment named
   `production`.
3. In that environment, add an environment secret named `DATABASE_URL`.
4. Set it to the **direct** PostgreSQL connection string suitable for Prisma
   Migrate (a `postgres://` / `postgresql://` URL, not a pooled/PgBouncer
   endpoint). Do not put this value in any repository file.
5. Review the production target identity in
   `constants/productionDatabaseIdentity.ts`. The repository ships an
   unresolved placeholder — a reserved `.invalid` host and an all-zero
   fingerprint — so the preflight halts until a maintainer replaces both
   through review. Follow the provisioning procedure in
   [production-database-identity.md](production-database-identity.md).
6. Optionally add **required reviewers** and other environment protection rules
   to `production` so a human must approve each migration run.

Running a migration:

7. Open the repository **Actions** tab.
8. Select the **Deploy production migrations** workflow.
9. Choose **Run workflow** on the intended branch and confirm.
10. Confirm the **Verify production database target identity** step reports
    `"action":"continue"`. A halt names the failing check — host, port,
    database name, cluster fingerprint, or marker — and the run stops there.
11. Confirm the **prisma migrate deploy** step succeeds (the run log shows the
    applied migrations, or "No pending migrations to apply").
12. Only then continue to the **Bootstrap production registry** workflow
    (see below) and the application deployment described below.

The workflow never prints the secret and adds no environment-dumping debug
steps. `DATABASE_URL` is the only secret it consumes; it does not use the
Vercel CLI, Vercel tokens, `CRON_SECRET`, `POSTGRES_URL`, or
`PRISMA_DATABASE_URL`. The production target identity is not a secret and is not
supplied to the workflow at all; it is read from the reviewed repository file.

## Preview policy

Preview deployments must not receive the production `DATABASE_URL` or `CRON_SECRET`. Until isolated preview database infrastructure exists, omit database secrets from previews; database-backed routes will fail safely rather than target production.

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
those can mutate the production registry. It runs the same read-only
target-identity preflight as the migration workflow and then exactly
`npm run bootstrap:registry` on `ubuntu-latest` with Node.js 22 after `npm ci`,
uses least-privilege `contents: read` permissions, a 10-minute job timeout, and
a non-cancelling `production-registry-bootstrap` concurrency group so two
bootstrap runs can never overlap.

A bootstrap is a mutation, so it is gated identically: the **Bootstrap registry**
step carries an explicit `if: ${{ success() }}`, and a preflight halt leaves the
registry untouched.

The bootstrap is manual and idempotent. It is normally required once for a
fresh production database, immediately after migrations and before the first
scheduled refresh. It may also be re-run deliberately after a reviewed change
to the anchor/corridor registry in the repository; re-running upserts the
current reviewed registry and reconciles associations without creating
duplicates. It creates no new anchors, infers no corridors, and never resets
data; it exits nonzero on any synchronization failure.

The `production` environment's `DATABASE_URL` secret is supplied to the
dependency-installation step, the preflight step, and the bootstrap step, for
the same reason as the migration workflow: `npm ci` runs `postinstall`
(`prisma generate`), which loads `prisma.config.ts`, and that configuration
resolves `DATABASE_URL`; without the secret `npm ci` fails with
`PrismaConfigEnvError` before the bootstrap runs. The secret stays scoped to
those steps rather than the whole workflow, and is never printed.
`DATABASE_URL` is the only secret the workflow consumes; it does not use the
Vercel CLI, Vercel tokens, `CRON_SECRET`, `POSTGRES_URL`, or
`PRISMA_DATABASE_URL`.

Running the bootstrap:

1. Confirm the **Deploy production migrations** workflow has completed
   successfully and the `production` environment / `DATABASE_URL` secret are in
   place (they are shared with the migration workflow).
2. Open the repository **Actions** tab.
3. Select the **Bootstrap production registry** workflow.
4. Choose **Run workflow** on the intended branch and confirm.
5. Confirm the **Verify production database target identity** step reports
   `"action":"continue"` before the registry is touched.
6. Confirm the **Bootstrap registry** step succeeds; the run log prints a safe
   structured JSON summary of anchor and corridor synchronization. A nonzero
   exit means at least one entry failed to synchronize — resolve it and
   re-run.
7. Only then continue to the application deployment and scheduled refresh
   described below.

## Scheduler

`vercel.json` schedules the single production-only refresh route once daily at `0 0 * * *` (midnight UTC), which is compatible with the Vercel Hobby plan. Vercel sends `CRON_SECRET` as a Bearer authorization header; the route uses constant-time validation, accepts GET only, returns bounded no-store JSON, and does not accept query-string credentials.

The locally verified run took about ten seconds. At the current reviewed scope of one rate source and three anchors, one Node.js function invocation is acceptable; this is a production observation, not an architectural limit. Add a distributed lock, chunking, or workers before the source/anchor set grows materially; Vercel does not retry failed cron invocations automatically.

## First production cycle

1. Review the production target identity in
   `constants/productionDatabaseIdentity.ts` so the preflight has an approved
   host, cluster fingerprint, and marker to enforce. The repository ships an
   unresolved placeholder, so this must happen before the first privileged run.
2. Apply committed migrations with the **Deploy production migrations**
   workflow (`.github/workflows/deploy-production-migrations.yml`). The
   preflight runs first and must report `"action":"continue"`.
3. Synchronize the reviewed registry with the **Bootstrap production registry**
   workflow (`.github/workflows/bootstrap-production-registry.yml`) and resolve
   any nonzero result.
4. Deploy or redeploy the Vercel application with `npm run build` as the build command.
5. Let the scheduled refresh ingest indicative rates, then evaluate the currently sparse reputation evidence. It does not ingest transfer outcomes.
6. Verify `GET /api/anchors`, `/api/corridors`, `/api/rates?corridor=usdc-us-brl-br`, `/api/reputation`, and `/api/reputation/zeam`.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.

A planned database replacement is a reviewed identity update, not an ad hoc
change. Follow the rotation procedure in
[production-database-identity.md](production-database-identity.md); the marker
row is never edited, and the outgoing target's fingerprint is only removed from
the approved list once it is decommissioned.
