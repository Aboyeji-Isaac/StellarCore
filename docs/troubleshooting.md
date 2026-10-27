# Troubleshooting local development

Known friction points when setting StellarCore up locally, each with a
working workaround. Every entry below was reproduced on a fresh clone before it
was written down; nothing here is documented from assumption.

Reproduced with: Node.js 24.18, npm 11.16, Prisma 7.9.1, `prisma dev` 0.16.28,
Linux. The repository targets Node.js 22.x (see `package.json` `engines`).
Behavior on other versions may differ.

If a problem is not listed here, please open an issue rather than guessing at a
fix; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Contents

- [`npm install` fails with `Cannot resolve environment variable: DATABASE_URL`](#npm-install-fails-with-cannot-resolve-environment-variable-database_url)
- [Prisma and the `tsx` scripts do not read `.env.local`](#prisma-and-the-tsx-scripts-do-not-read-envlocal)
- [Scripts print `{"ok":false,"code":"READ_FAILURE"}`](#scripts-print-okfalsecoderead_failure)
- [Prisma Dev](#prisma-dev)
  - [`prisma dev` fails before it starts](#prisma-dev-fails-before-it-starts)
  - [`prisma migrate dev` fails with `P3005` on Prisma Dev](#prisma-migrate-dev-fails-with-p3005-on-prisma-dev)
  - [`prisma dev start` exits 1 with no output after an unclean shutdown](#prisma-dev-start-exits-1-with-no-output-after-an-unclean-shutdown)

## `npm install` fails with `Cannot resolve environment variable: DATABASE_URL`

**Symptom.** On a fresh clone, `npm install` (or `npm ci`) exits with code 1:

```text
> prisma generate

Failed to load config file "…/StellarCore" as a TypeScript/JavaScript module.
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
npm error code 1
npm error command sh -c prisma generate
```

**Why.** The `postinstall` script runs `prisma generate`, and
`prisma.config.ts` requires `DATABASE_URL` to be set just to load the config,
even though generating the client never connects to a database. The README lists
`npm install` before the step that creates the environment file, so a new
contributor hits this first.

**Side effect.** The failed install still leaves `node_modules` in place but
never generates the Prisma client (`app/generated/prisma`). Later commands then
fail with a confusing error, for example `npm test`:

```text
Error: Cannot find module '@/app/generated/prisma/client'
```

**Fix.** Provide any syntactically valid URL for the install. It is not used to
connect, so a placeholder is enough:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/stellarcore" npm install
```

If you already ran a bare `npm install`, you do not need to reinstall. Generate
the client and continue:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/stellarcore" npx prisma generate
npm test   # runs offline; no live database needed
```

Alternatively, create `.env` (not `.env.local`, see the next entry) with your
real `DATABASE_URL` before installing.

## Prisma and the `tsx` scripts do not read `.env.local`

**Symptom.** You followed the README (`cp .env.example .env.local`, then filled
in `DATABASE_URL`), but Prisma commands and the maintenance scripts act as if it
is unset.

`npx prisma generate` (and any other Prisma CLI command):

```text
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
```

`npm run verify:latest-rates` (and the other `tsx` scripts):

```text
Error: DATABASE_URL is not defined
    at createPrismaClient (lib/dbClient.ts:13:11)
```

**Why.** `prisma.config.ts` and the scripts load the environment with
`import "dotenv/config"`, which reads only `.env`, never `.env.local`.

**Fix.** Put `DATABASE_URL` in `.env` (also git-ignored). Copying the same value
into `.env` makes all of the above work; with it in place, `npx prisma generate`
succeeds and the scripts connect. `.env` is listed in `.gitignore`, so it will
not be committed.

```bash
cp .env.example .env
# then edit DATABASE_URL in .env
```

## Scripts print `{"ok":false,"code":"READ_FAILURE"}`

**Symptom.** With `DATABASE_URL` set correctly in `.env`, a script such as
`npm run verify:latest-rates` prints only:

```json
{"ok":false,"code":"READ_FAILURE"}
```

**Why.** It is the script's generic failure code. In the case reproduced here
nothing was listening at the address in `DATABASE_URL`, so the database read
failed, but the output does not say so.

**Fix.** Confirm the database is actually running and that host, port, and
credentials in `DATABASE_URL` are right. If you use Prisma Dev, check
`npx prisma dev ls` shows your server as `running` (see below).

## Prisma Dev

Prisma Dev (`npx prisma dev`) runs a local PostgreSQL-compatible server and is
a convenient way to get a `DATABASE_URL` without installing PostgreSQL. The
README requires "PostgreSQL accessible through a direct connection URL", so use
the `postgres://…` TCP URL that Prisma Dev prints.

A working setup, in order:

```bash
# 1. Start a named server in the background and note the printed URL
DATABASE_URL="postgresql://user:pass@localhost:5432/stellarcore" \
  npx prisma dev --name stellarcore --detach
# -> postgres://postgres:postgres@localhost:51214/template1?sslmode=disable

# 2. Put that URL in .env as DATABASE_URL
# 3. Apply migrations with `migrate deploy` (not `migrate dev`, see below)
npx prisma migrate deploy

# 4. Continue with the README: bootstrap the registry, start the dev server
npm run bootstrap:registry
npm run dev
```

The full flow above (migrate, bootstrap with 3 of 3 anchors and 3 of 3
corridors succeeding, dev server returning `GET /api/anchors 200`) was
reproduced against Prisma Dev. The first request to each route is slow while
Next.js compiles it (about 12 to 18 seconds here); that is normal for `next
dev`.

### `prisma dev` fails before it starts

**Symptom.** Even `npx prisma dev --help` fails when `DATABASE_URL` is unset:

```text
Failed to load config file "…/StellarCore" as a TypeScript/JavaScript module.
Error: PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL.
```

**Why.** It is the same config-loading requirement as in the first entry, which
is circular here: Prisma Dev exists to give you a `DATABASE_URL`, but the CLI
will not run without one.

**Fix.** Set a placeholder just for this command, as in step 1 above. The real
URL comes from the command's output.

### `prisma migrate dev` fails with `P3005` on Prisma Dev

**Symptom.** The README's migration step (`npx prisma migrate dev`) fails on a
brand-new Prisma Dev server:

```text
Error: P3005

The database schema is not empty. Read more about how to baseline an existing
production database: https://pris.ly/d/migrate-baseline
```

Worse, it leaves the server dirty. Afterwards the six application tables exist
(`anchors`, `corridors`, `anchor_corridors`, `rate_snapshots`,
`transfer_outcomes`, `reputation_scores`) but there is no `_prisma_migrations`
table, so **`npx prisma migrate deploy` now also fails with the same `P3005`**,
and pointing `migrate dev` at the `postgres` database instead gives
`P3006 … type "anchor_status" already exists`.

**Why.** Not confirmed at the source, but the evidence points at the shadow
database. Prisma Dev appears to serve one database instance regardless of the
database name in the URL (`template1` and `postgres` showed identical tables),
and `migrate dev` applies migrations to a shadow database first, so the
migrations end up in the same place as your real database.

**Fix.** Use `migrate deploy`, which does not use a shadow database. On a
fresh Prisma Dev server it applies both existing migrations and
`npx prisma migrate status` then reports "Database schema is up to date!":

```bash
npx prisma migrate deploy
```

If you already ran `migrate dev` and the server is dirty, throw the server away
and start again (this deletes its data, which is fine for local development):

```bash
npx prisma dev rm stellarcore --force
DATABASE_URL="postgresql://user:pass@localhost:5432/stellarcore" \
  npx prisma dev --name stellarcore --detach
npx prisma migrate deploy
```

Note: I did not find a way to run `migrate dev` (for authoring new migrations)
against Prisma Dev. Use a regular PostgreSQL server for that.

### `prisma dev start` exits 1 with no output after an unclean shutdown

**Symptom.** After the Prisma Dev process is killed rather than stopped (a
crash, a forced kill, or a machine that lost power), `npx prisma dev ls` lists
the server as `not_running`, and the first attempt to restart it prints only
the "Starting the following prisma dev servers" banner, exits with code 1, and
leaves the server `not_running`:

```bash
npx prisma dev start stellarcore   # exit 1, no error, still not_running
```

**Why.** Not determined. The failure is silent, and I did not find the cause.
What was reproduced is the pattern: in 4 of 4 attempts (`kill -9` of the server
daemon, then an immediate `start`) the first start failed.

**Fix.** Wait a few seconds and start it again. In every reproduced run, a
retry about 8 seconds later succeeded, printed the connection URLs, and
`prisma dev ls` showed the server as `running`:

```bash
npx prisma dev start stellarcore
```

If it still will not start, remove and recreate the server as in the previous
entry (`npx prisma dev rm stellarcore --force`, then start it again and re-run
`npx prisma migrate deploy`).
