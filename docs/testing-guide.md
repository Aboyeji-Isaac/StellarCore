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

## Privileged workflow guards

Tests that guard a production boundary assert against the artifacts themselves,
not against a description of them.
`tests/unit/config/productionDatabaseWorkflows.test.ts` reads the workflow YAML
directly, so deleting the preflight, moving it after the mutation, dropping the
`if: ${{ success() }}` gate, or widening the secret to a job-level `env:` block
fails the suite instead of passing review.

Tests for a database-identity check must cover both directions — the correct
target continues, and a credential that authenticates successfully against the
wrong database halts — and must assert that the reported diagnostic contains no
connection string, username, or password. Inject the client or observer rather
than opening a connection, and drive the real query path with a recording stub so
the statements themselves can be asserted read-only.

`tests/integration/config/productionDatabasePreflight.database.integration.test.ts`
covers the same properties against a real server, because read-only enforcement
and `inet_server_addr()` are server behaviour rather than SQL we control. It is
opt-in via `RUN_PRODUCTION_DATABASE_PREFLIGHT_INTEGRATION=1` and never runs as
part of `npm test`.
