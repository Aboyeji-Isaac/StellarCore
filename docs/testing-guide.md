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

## Database integration tests

The database-backed integration tests are opt-in and skipped by default. Run the
operator-audit tests against an isolated PostgreSQL (never production
credentials or production load):

```bash
RUN_OPERATOR_AUDIT_DATABASE_INTEGRATION=1 \
DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE" \
npx tsx --test tests/integration/audit/operatorAuditLedger.database.integration.test.ts
```

The ledger is append-only at the database level, so those tests never delete
audit rows; they use unique identifiers and scope every assertion to them. See
[operator-audit.md](operator-audit.md) for the guarantees each test proves.

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
