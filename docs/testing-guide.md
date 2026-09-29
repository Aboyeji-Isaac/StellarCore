# Testing guide

StellarCore uses Node's built-in test runner through `tsx`. Use Node.js 22.x,
install dependencies with `npm ci`, and run the full suite with:

```bash
npm test
```

The `test` script expands `tests/**/*.test.ts`, so test files must end in
`.test.ts`. Unit tests live under `tests/unit/` and should exercise one module
or subsystem without requiring a database or live network. Integration tests
live under `tests/integration/` and cover boundaries such as the database,
HTTP handlers, or other configured services. Keep the test file near the
subsystem it covers and use descriptive test names that state the behavior and
failure condition.

## Focused tests

Run one file directly with:

```bash
npx tsx --test tests/unit/stellar/sep38.test.ts
```

Filter by test name when a file contains many cases:

```bash
npx tsx --test --test-name-pattern="timeout" tests/unit/stellar/sep38.test.ts
```

`npm run lint` checks the repository, and `npx tsc --noEmit` performs the
TypeScript check without emitting files.

## Database role tests

`tests/integration/database/roles.database.integration.test.ts` proves the
least-privilege PostgreSQL roles against a real server. It creates a throwaway
database and synthetic owner, reader, and writer roles, applies the committed
migrations as the synthetic owner, applies `npm run db:grants`'s plan, and
checks that public read paths succeed as the reader, approved mutation paths
succeed as the writer, forbidden DML/DDL fails for each role, and a table added
by a later migration receives the intended default grants. It uses only
synthetic fixtures and drops everything it created.

It is opt-in and needs an isolated PostgreSQL server where the admin role has
`CREATEDB` and `CREATEROLE`:

```bash
RUN_DATABASE_ROLE_INTEGRATION=1 \
DATABASE_ROLE_TEST_ADMIN_URL="postgresql://ADMIN:PASSWORD@localhost:5432/postgres" \
npm test -- tests/integration/database
```

The **Database role boundaries** workflow runs it against an ephemeral
PostgreSQL service on pull requests. The other opt-in database tests
(`RUN_DATABASE_INTEGRATION`, `RUN_REPUTATION_DATABASE_INTEGRATION`,
`RUN_REPUTATION_API_DATABASE_INTEGRATION`) exercise application code through
`DATABASE_READ_URL` / `DATABASE_WRITE_URL` and seed and remove their synthetic
fixtures through `MIGRATION_DATABASE_URL`, because the runtime roles
intentionally cannot delete evidence.

## Mocking network calls

Unit tests must inject a fetch implementation rather than call an anchor. The
SEP-38 tests are the reference pattern: pass a `fetcher` option, inspect the
requested URL, and return a deterministic `Response`.

```ts
const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
  const url = new URL(String(input));
  assert.equal(url.pathname, "/sep38/info");
  return new Response(JSON.stringify({ assets: [] }), {
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const result = await getSep38Info("https://anchor.example/sep38", { fetcher });
```

Use explicit status codes, headers, and bodies to model timeout, malformed
JSON, and upstream errors. Do not weaken production validation just to make a
test pass. Live integrations belong in an explicitly configured integration
environment and must not run as part of the default unit suite.
