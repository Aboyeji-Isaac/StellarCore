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

`DATABASE_URL` must be a `postgres://` or `postgresql://` URL. The application runtime uses the credential configured for its deployment environment. The protected GitHub Actions production environment separately stores the direct Prisma Postgres credential used by `prisma migrate deploy` under the same `DATABASE_URL` secret name. Do not expose either credential through `NEXT_PUBLIC_*`, repository files, or logs.

## Environment identity and database isolation (issue #143)

Every runtime declares exactly one environment identity through
`STELLARCORE_ENVIRONMENT`: `production`, `preview`, `development`, `test`, or
`ci`. It is never inferred from hostnames. Every database carries a durable,
one-row identity in its `environment_identity` table, written once by the
provisioning step that created the database:

```bash
STELLARCORE_ENVIRONMENT=preview npx tsx scripts/mark-database-environment.ts
```

Production marking is deliberately interactive-only (no environment-variable
override), so a stray CI variable can never mark a database as production.

At first database access — and at the cron refresh and registry bootstrap
boundaries — the runtime verifies that the runtime identity and the durable
database identity match, and **fails closed** when they do not, before any
evidence is read or mutated. The compatibility matrix is exactly: a runtime
matches only a database durably marked with the same environment. Consequences:

- A preview or test runtime pointed at a production-marked database cannot
  connect, let alone mutate evidence.
- Production never falls back to preview/test/CI credentials or to an
  unmarked database.
- Mismatch errors are bounded, typed, and secret-free: they never contain the
  database URL, credentials, or connection details.
- Test and CI databases are isolated synthetic PostgreSQL instances marked
  with explicit non-production identities.

Migration tooling has an explicit boundary: `prisma migrate deploy` runs only
in the protected `production` GitHub Actions workflow, which declares
`STELLARCORE_ENVIRONMENT: production` and therefore refuses to migrate a
database that is not durably marked production. The full pairing matrix is
covered by
`tests/integration/config/environmentIdentity.database.integration.test.ts`
(enable with `RUN_DATABASE_ENVIRONMENT_INTEGRATION=1` against an isolated
test database).

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

## SBOM and build provenance (issue #142)

Every production release record is produced by CI, never handwritten. The
manual **Release SBOM and provenance** workflow
(`.github/workflows/release-sbom-provenance.yml`, `workflow_dispatch` only)
checks out a chosen revision, installs exactly the locked dependency graph
(`npm ci`), and emits:

1. **SBOM** — a CycloneDX JSON document generated from `package-lock.json`
   (the lockfile actually used for installation) by `@cyclonedx/cyclonedx-npm`.
2. **Deployment bundle** — a tarball of the built application for the exact
   commit (Node 22 runtime, `npm ci` install).
3. **Build manifest** (`scripts/write-build-manifest.mjs`) — the commit SHA,
   workflow run identity, Node/npm versions, and SHA-256 digests of the
   lockfile, `package.json`, and the SBOM.
4. **Signed provenance** — GitHub-issued SLSA build provenance
   (`actions/attest-build-provenance`) binding every artifact to the commit
   SHA and workflow run; it is generated by the GitHub control plane from the
   checked-out revision, not by repository code.

Artifacts are named `stellarcore-supply-chain-<commit-sha>` and are retained
for 90 days. The workflow consumes no environment secrets and never touches a
database (a placeholder `DATABASE_URL` satisfies Prisma code generation), so
no secrets or database contents can enter the record. The writer additionally
refuses to emit a manifest containing any environment value — a belt-and-
braces guard against accidental secret leakage.

Verifying a release locally:

```bash
# Verify the checked-out tree against a downloaded manifest.json (exit 1 on
# digest drift, missing subjects, or an unresolved commit):
npm run verify:supply-chain -- manifest.json

# Verify the verifier itself, including a deliberately mismatched
# artifact/attestation fixture that must FAIL (no database or network needed):
npm run verify:supply-chain -- --self-test
```

For the strongest check, download the `stellarcore-supply-chain-<sha>`
artifact, then confirm the GitHub-signed attestation with the
`gh attestation verify` CLI against this repository; the digest in the
manifest, the SBOM, and the attestation subject must all name the same commit.
A lockfile or source change produces different digests, which makes verification
fail closed — digest drift is never silently ignored on release paths. Build
provenance proves how StellarCore software was built; it is not anchor, rate,
or transfer evidence, and production database contents are never included in
any artifact.

## Rollback

Redeploy the prior application artifact when needed. Database migration rollback is a separate, reviewed change: do not reset or reverse a production database ad hoc. Disable the Vercel cron before any planned database maintenance that would make refresh unsafe.
