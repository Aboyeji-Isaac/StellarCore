# Production deployment

StellarCore is prepared for a Vercel deployment backed by managed PostgreSQL and Prisma ORM. This guide prepares deployment only; it does not provision or modify hosted services.

## Architecture

- Next.js 15 App Router deploys as Vercel Node.js functions.
- Prisma Client uses the `PrismaPg` adapter with a direct PostgreSQL connection.
- Public API routes are read-only. The refresh route is a Node.js-only, authenticated internal mutation boundary.
- Vercel Cron invokes only `/api/internal/cron/refresh` on production deployments.

## Environment

| Name | Production | Secret | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | Required | Yes | Direct PostgreSQL connection for runtime and Prisma CLI. |
| `CRON_SECRET` | Required when cron is enabled | Yes | Bearer secret Vercel sends to the refresh route. |

`DATABASE_URL` must be a `postgres://` or `postgresql://` URL. Prisma 7 configuration uses it for both the CLI and the `PrismaPg` runtime adapter; `DIRECT_URL` is not used. Do not expose either variable through `NEXT_PUBLIC_*`.

## Migration strategy

1. Provision the managed PostgreSQL database and set only production-scoped `DATABASE_URL` in the deployment/CI environment.
2. From a protected CI/release step, run `npx prisma migrate deploy` once against that environment.
3. Confirm `npx prisma migrate status` is current.
4. Deploy the application with `npm run build`.

Do not run `prisma migrate dev`, `prisma db push`, reset commands, or `migrate deploy` from ordinary Vercel builds. Keeping migrations outside the build prevents preview deployments from mutating a shared production database.

## Preview policy

Preview deployments must not receive the production `DATABASE_URL` or `CRON_SECRET`. Until isolated preview database infrastructure exists, omit database secrets from previews; database-backed routes will fail safely rather than target production.

## Bootstrap

After migrations, run the explicit, idempotent command once in the protected production job environment:

```bash
npm run bootstrap:registry
```

It uses the existing reviewed registries and synchronization logic to discover/upsert anchors, upsert corridors, and reconcile associations. It prints safe structured results and exits nonzero for failures. It is never called by a web request, build, or cron route.

## Scheduler

`vercel.json` schedules the single production-only refresh route every ten minutes (`*/10 * * * *`). Vercel sends `CRON_SECRET` as a Bearer authorization header; the route uses constant-time validation, accepts GET only, returns bounded no-store JSON, and does not accept query-string credentials.

The locally verified run took about ten seconds. This MVP has one reviewed source and three anchors, so one Node.js function invocation is currently acceptable. Add a distributed lock, chunking, or workers before the source/anchor set grows materially; Vercel does not retry failed cron invocations automatically.

## First production cycle

1. Apply committed migrations.
2. Run `npm run bootstrap:registry` and resolve any nonzero result.
3. Deploy or redeploy the Vercel application with `npm run build` as the build command.
4. Let the scheduled refresh ingest indicative rates, then evaluate reputations.
5. Verify `GET /api/anchors`, `/api/corridors`, `/api/rates?corridor=usdc-us-brl-br`, `/api/reputation`, and `/api/reputation/zeam`.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.
