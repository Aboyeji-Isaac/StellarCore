# Production deployment

StellarCore is prepared for a Vercel deployment backed by managed PostgreSQL and Prisma ORM. This guide prepares deployment only; it does not provision or modify hosted services.

## Architecture

- Next.js 15 App Router deploys as Vercel Node.js functions.
- Prisma Client uses the `PrismaPg` adapter with a server-only PostgreSQL connection supplied as `DATABASE_URL` for the running environment.
- Public API routes are read-only. The internal capture, reputation-evaluation, and cadence-health routes are Node.js-only, authenticated boundaries.
- Vercel Cron invokes `/api/internal/cron/refresh` daily. Reviewed rate capture is a separate, independently authenticated boundary whose schedule is gated on a maintainer-approved provider (see [scheduler-cadence.md](scheduler-cadence.md)).

## Environment

| Name | Production | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | Yes | Server-only PostgreSQL connection appropriate to the running environment. The protected migration workflow separately configures its direct Prisma Postgres credential under this secret name. |
| `CRON_SECRET` | Required when cron is enabled | Yes | Bearer secret the scheduler sends to the internal capture, reputation-evaluation, and cadence-health routes. |
| `RATE_CAPTURE_SCHEDULER` | Optional; unset means disabled | No | Server-only selection of the approved capture scheduler (`vercel-cron` or `external`). Unset or unrecognised resolves to the explicit `disabled` state, in which the capture route refuses to run. |

`DATABASE_URL` must be a `postgres://` or `postgresql://` URL. The application runtime uses the credential configured for its deployment environment. The protected GitHub Actions production environment separately stores the direct Prisma Postgres credential used by `prisma migrate deploy` under the same `DATABASE_URL` secret name. Do not expose either credential through `NEXT_PUBLIC_*`, repository files, or logs.

## Migration strategy

1. Configure the server-only runtime `DATABASE_URL` for the production deployment, and separately configure the protected GitHub Actions `production` environment's direct Prisma Postgres credential as its `DATABASE_URL` secret.
2. From a protected CI/release step, run `npx prisma migrate deploy` once against that environment.
3. Confirm `npx prisma migrate status` is current.
4. Deploy the application with `npm run build`.

Do not run `prisma migrate dev`, `prisma db push`, reset commands, or `migrate deploy` from ordinary Vercel builds. Keeping migrations outside the build prevents preview deployments from mutating a shared production database.

## Production migration workflow (GitHub Actions)

The protected step above is implemented as a manual GitHub Actions workflow:
`.github/workflows/deploy-production-migrations.yml`. It is triggered only by
`workflow_dispatch` and is intentionally separate from Vercel builds, so a
preview or an ordinary build can never mutate the production database. It runs
exactly `npx prisma migrate deploy` on `ubuntu-latest` with Node.js 22 after
`npm ci`, uses least-privilege `contents: read` permissions, a 10-minute job
timeout, and a non-cancelling `production-database-migration` concurrency group
so two migration runs can never overlap.

The `production` environment's `DATABASE_URL` secret is supplied to both the
dependency-installation step and the migration step. `npm ci` runs the
`postinstall` script (`prisma generate`), which loads `prisma.config.ts`, and
that configuration resolves `DATABASE_URL`; without the secret the install step
fails with `PrismaConfigEnvError: Cannot resolve environment variable:
DATABASE_URL` before any migration runs. The secret stays scoped to those two
steps rather than the whole workflow, and is never printed.

One-time setup (repository admin):

1. Open the GitHub repository **Settings**.
2. Under **Environments**, create a GitHub Actions environment named
   `production`.
3. In that environment, add an environment secret named `DATABASE_URL`.
4. Set it to the **direct** PostgreSQL connection string suitable for Prisma
   Migrate (a `postgres://` / `postgresql://` URL, not a pooled/PgBouncer
   endpoint). Do not put this value in any repository file.
5. Optionally add **required reviewers** and other environment protection rules
   to `production` so a human must approve each migration run.

Running a migration:

6. Open the repository **Actions** tab.
7. Select the **Deploy production migrations** workflow.
8. Choose **Run workflow** on the intended branch and confirm.
9. Confirm the **prisma migrate deploy** step succeeds (the run log shows the
   applied migrations, or "No pending migrations to apply").
10. Only then continue to the **Bootstrap production registry** workflow
    (see below) and the application deployment described below.

The workflow never prints the secret and adds no environment-dumping debug
steps. `DATABASE_URL` is the only secret it consumes; it does not use the
Vercel CLI, Vercel tokens, `CRON_SECRET`, `POSTGRES_URL`, or
`PRISMA_DATABASE_URL`.

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

The `production` environment's `DATABASE_URL` secret is supplied to both the
dependency-installation step and the bootstrap step, for the same reason as the
migration workflow: `npm ci` runs `postinstall` (`prisma generate`), which
loads `prisma.config.ts`, and that configuration resolves `DATABASE_URL`;
without the secret the install step fails with `PrismaConfigEnvError` before
the bootstrap runs. The secret stays scoped to those two steps rather than the
whole workflow, and is never printed. `DATABASE_URL` is the only secret the
workflow consumes; it does not use the Vercel CLI, Vercel tokens, `CRON_SECRET`,
`POSTGRES_URL`, or `PRISMA_DATABASE_URL`.

Running the bootstrap:

1. Confirm the **Deploy production migrations** workflow has completed
   successfully and the `production` environment / `DATABASE_URL` secret are in
   place (they are shared with the migration workflow).
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

StellarCore runs two independent, individually authenticated schedules. The
full contract, provider approval process, and operator semantics are in
[scheduler-cadence.md](scheduler-cadence.md).

**Reputation evaluation.** `vercel.json` schedules `/api/internal/cron/refresh`
once daily at `0 0 * * *` (midnight UTC), which is compatible with the Vercel
Hobby plan. It reads persisted evidence only and never captures a rate.

**Reviewed rate capture.** `RATE_FRESHNESS_THRESHOLD_MS` is 120 seconds and is
evaluated at read time, so capture must run on a sub-minute cadence to keep an
observation fresh. That schedule targets `/api/internal/cron/capture-rates` and
is **disabled by default**: set `RATE_CAPTURE_SCHEDULER` to `vercel-cron` or
`external` only after a maintainer records the provider decision, and only
after applying that provider's checked-in manifest.

| Provider | Schedule | Deployment requirement |
| --- | --- | --- |
| `vercel-cron` | `* * * * *` (60 s) | Merge `deploy/scheduler/vercel-cron.capture.json`'s `vercelCron` fragment into `vercel.json` `crons[]`. Requires a plan that supports per-minute cron. |
| `external` | 60 s | Register the external schedule with the approved provider. `vercel.json` must not schedule the capture route. |

The maximum supported interval is derived, not declared: `120 s` freshness
threshold minus a documented `30 s` execution safety margin leaves `90 s`.
Both 60 s options fit.

Repository validation rejects a cadence that cannot fit that budget:

```bash
npm run audit:scheduling
```

It is offline and deterministic and exits nonzero on an incompatible cadence,
an unbounded cron expression, a manifest/deployment disagreement, two
schedulers pointed at the capture route, or a missing daily reputation entry.
Run it before deploying and in CI; the application also re-checks the deployed
schedule at request time and refuses to capture rather than running at a
cadence the freshness rule cannot support.

Vercel sends `CRON_SECRET` as a Bearer authorization header; every internal
route uses constant-time validation, accepts GET only, returns bounded
`no-store` JSON, and does not accept query-string credentials. Vercel does not
retry failed cron invocations automatically, which is why overlap, delayed
dispatch, and missed runs are handled as ordinary states rather than errors:
capture writes durable run lineage before doing work, holds a PostgreSQL
advisory lock for the whole invocation, and stops at a bounded execution
budget. A delayed or missed run leaves the persisted evidence stale rather than
backfilling an observation.

## First production cycle

1. Apply committed migrations with the **Deploy production migrations**
   workflow (`.github/workflows/deploy-production-migrations.yml`).
2. Synchronize the reviewed registry with the **Bootstrap production registry**
   workflow (`.github/workflows/bootstrap-production-registry.yml`) and resolve
   any nonzero result.
3. Deploy or redeploy the Vercel application with `npm run build` as the build command.
4. Verify the checked-in schedule with `npm run audit:scheduling`, enable the approved capture provider, and let capture ingest indicative rates. The daily reputation job then evaluates the currently sparse persisted evidence. Neither job ingests transfer outcomes.
5. Verify `GET /api/anchors`, `/api/corridors`, `/api/rates?corridor=usdc-us-brl-br`, `/api/reputation`, and `/api/reputation/zeam`.
6. Verify the operator signal `GET /api/internal/capture-health`. A `missed`
   state means the capture process did not run; it is not anchor downtime. With
   the single reviewed Zeam source, expect `insufficient_fresh_sources` and a
   null median even when the cadence is healthy.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.
