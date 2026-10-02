# Runtime database resource budget

StellarCore bounds its runtime PostgreSQL resource use so an exhausted pool, a
slow statement, or a lock wait cannot consume an entire request or scheduled-run
budget. The policy is typed, validated, and documented; there is no "unlimited"
value.

This document covers the application runtime boundary only. It does not change
scoring, evidence, or anchor health, and a database overload is an operational
failure of StellarCore — it is never proof that an anchor is down.

## Roles and pools

Two process-scoped pools are created lazily, each with its own budget:

| Role | Used by | Connection URL |
| --- | --- | --- |
| `read` | Public read-only API routes and the dashboard | `DATABASE_READ_URL` else `DATABASE_URL` |
| `write` | Authenticated refresh, registry bootstrap, reputation writes | `DATABASE_WRITE_URL` else `DATABASE_URL` |

`db` exported from `lib/dbClient.ts` is the `read` client. Write paths call
`getWriteDatabaseClient()`. Neither requires migration-owner or operator
credentials: `DIRECT_URL`, `PRISMA_DATABASE_URL`, and
`MIGRATION_DATABASE_URL` are never read. A saturated read pool cannot borrow
write capacity because the pools are separate. When only `DATABASE_URL` is set,
both roles use that single least-privilege runtime credential.

Normal request completion never disconnects a shared pool. Long-lived CLI
entrypoints call `disconnectRuntimeDatabaseClients()` once on shutdown.

## Configuration

Every knob has a finite inclusive safe range. A profile-specific variable
overrides the global variable, which overrides the built-in default. A variable
that is present but invalid is an error: it never falls through to the next
level, and it can never disable the policy. `0`, `false`, `off`, `none`,
`unlimited`, `infinity`, negatives, non-integers, and values outside the range
are all rejected.

| Knob (suffix) | Unit | Safe range | Read default | Write default |
| --- | --- | --- | ---: | ---: |
| `POOL_MAX` | connections | 1–100 | 4 | 4 |
| `CONNECTION_TIMEOUT_MS` | milliseconds | 100–120000 | 2000 | 5000 |
| `POOL_IDLE_TIMEOUT_MS` | milliseconds | 1000–3600000 | 30000 | 30000 |
| `POOL_MAX_LIFETIME_SECONDS` | seconds | 1–86400 | 1800 | 1800 |
| `STATEMENT_TIMEOUT_MS` | milliseconds | 100–600000 | 3000 | 15000 |
| `LOCK_TIMEOUT_MS` | milliseconds | 100–600000 | 1000 | 5000 |
| `IDLE_IN_TRANSACTION_TIMEOUT_MS` | milliseconds | 100–600000 | 5000 | 30000 |
| `INTERACTIVE_TRANSACTION_TIMEOUT_MS` | milliseconds | 100–600000 | 3000 | 20000 |
| `INTERACTIVE_TRANSACTION_MAX_WAIT_MS` | milliseconds | 100–600000 | 1000 | 5000 |

Variable names are `DB_<suffix>` globally and `DB_<READ|WRITE>_<suffix>` per
profile. `DB_APPLICATION_NAME` (max 63 characters, `A-Za-z0-9_.:-`) sets the base
application name; each pool reports `:<role>` so ownership is visible in
`pg_stat_activity`.

Consistency invariants are enforced per profile:

- `LOCK_TIMEOUT_MS <= STATEMENT_TIMEOUT_MS`
- `STATEMENT_TIMEOUT_MS <= INTERACTIVE_TRANSACTION_TIMEOUT_MS`
- `INTERACTIVE_TRANSACTION_MAX_WAIT_MS <= INTERACTIVE_TRANSACTION_TIMEOUT_MS`

### Conflicting connection-string parameters

`node-postgres` merges parsed URL parameters over the provided configuration.
To make precedence explicit rather than accidental, these URL parameters are
rejected: `connection_limit`, `pool_timeout`, `statement_timeout`,
`lock_timeout`, `idle_in_transaction_session_timeout`, `query_timeout`, and
`application_name`. A `options` parameter that sets a budget GUC
(`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`,
`transaction_timeout`, `default_transaction_read_only`) is rejected too.
Unrelated options such as `-c search_path=public` remain allowed. Only
`postgres://` and `postgresql://` are accepted, matching the existing
`PrismaPg` requirement.

## Which layer enforces each bound

| Bound | Owner | Behavior on breach |
| --- | --- | --- |
| Pool size (`POOL_MAX`) | `pg.Pool.max` | No more physical connections exist than the cap |
| Waiting for a free pool slot | `pg.Pool` `connectionTimeoutMillis` | Request rejected; no server statement runs |
| Establishing a new physical connection | `pg.Pool` `connectionTimeoutMillis` | Socket destroyed; connect rejected |
| Individual statement | PostgreSQL `statement_timeout` startup parameter | Server cancels the statement and aborts the transaction |
| Lock wait | PostgreSQL `lock_timeout` startup parameter | Server cancels the blocked statement and aborts the transaction |
| Idle open transaction | PostgreSQL `idle_in_transaction_session_timeout` startup parameter | Server terminates the session; the pool discards and replaces the connection |
| Interactive transaction | Prisma `$transaction` `timeout`/`maxWait` | Client-side backstop; server-side limits remain authoritative |

`query_timeout` is intentionally **not** set. In the installed `pg` version it
is a client-side abandonment that does not prove a mutation was terminated, so
it is not a sufficient bound for writes. Server-side `statement_timeout` is the
authoritative statement bound, and it cancels and rolls back rather than merely
detaching.

## Installed-version behavior and evidence

- `@prisma/adapter-pg` `7.9.1`, `pg` `8.23.0`, `@prisma/client` `7.9.1`, Node 22.
- The `PrismaPg` adapter accepts an external `pg.Pool`, which is how the bounded
  pool is owned and observed.
- `pg-pool` applies `connectionTimeoutMillis` to **both** checking out a client
  while the pool is at `max` and establishing a new connection
  (`node_modules/pg-pool/index.js`: the "timeout on checking out an existing
  client" branch and the `newClient` connect-timeout branch). A saturated pool
  therefore fails a queued acquisition within the configured bound.
- `pg` sends `application_name`, `statement_timeout`, `lock_timeout`, and
  `idle_in_transaction_session_timeout` in the connection startup packet
  (`node_modules/pg/lib/client.js`), so they are per-connection server settings
  applied at connect time — not `SET` statements that could leak through a
  pooled session.
- Reference: <https://node-postgres.com/apis/pool>.
- Integration evidence: `tests/integration/db/databaseBudget.integration.test.ts`
  runs against an isolated PostgreSQL and asserts the bound and recovery
  behavior. Run it with:

  ```bash
  RUN_DATABASE_BUDGET_INTEGRATION=1 \
  TEST_DATABASE_URL="postgresql://USER:PASSWORD@HOST:PORT/DATABASE" \
  npx tsx --test tests/integration/db/databaseBudget.integration.test.ts
  ```

## Transaction pooling

The server-side limits travel in the connection startup packet, so they are
applied to every physical server connection the driver opens.

- **Direct connections (supported):** one startup handshake per connection, one
  bounded session policy per connection.
- **Transaction-pooling deployments (for example PgBouncer `transaction` mode):**
  the client still receives per-connection startup parameters, but the pooler
  maps many client "connections" onto fewer server connections and may keep its
  own settings. StellarCore does not claim provider guarantees here: if you use a
  transaction pooler, configure the same statement/lock/idle limits on the
  pooler's server connections as well, and re-verify with the integration test
  against a pooler before relying on it. `max` still bounds the application's
  client-side pool regardless of the pooler.

## Per-instance versus total sizing

The budget is per process/instance. Worst-case application connections are:

```
total app connections = instance count x (read.POOL_MAX + write.POOL_MAX)
```

Example: 20 serverless instances at the default read 4 + write 4 = up to 160
application connections, plus migration and operator sessions. Set the database
provider's global limit above that sum, or reduce the per-instance pools. With a
provider limit of 100 and the same 20 instances, use read 2 + write 2 (80 app
connections) to leave room for migrations and operators. The application bound
is distinct from any provider/global limit; this project does not add a
distributed admission service.

## Timeout ordering

Bounds are nested so a smaller bound always fails first, and the largest sits
inside the request or cron deadline:

```
pool acquisition / connection  <  lock wait  <=  statement
        <=  interactive transaction  <  request or cron deadline
```

Read profile: connection 2s, lock 1s, statement 3s, interactive transaction 3s —
comfortably inside a typical short-lived API function. Write profile:
connection 5s, lock 5s, statement 15s, interactive transaction 20s — inside the
daily cron/refresh budget. If you raise a database bound, keep this ordering and
keep every bound below the deployment's function/route deadline.

## Failure translation

Resource-exhaustion failures are classified into a bounded, secret-free
`DatabaseResourceError`. Its message contains no connection string, SQL,
database host/user, or raw driver message. The public API envelope and status
contracts are unchanged: unexpected reads still return HTTP 500 `internal_error`
with a static message, and the refresh route still returns its existing safe
errors.

`DATABASE_CONNECTION_LOSS` is documented separately: a connection loss does not
prove whether a prior commit succeeded. Non-idempotent writes are never
automatically retried after an ambiguous connection failure.

## Unit coverage

`npm test` includes the budget, URL-conflict, and error-translation unit tests.
The PostgreSQL integration tests are opt-in and skipped by default; they never
use production credentials or production load and use synthetic fixtures in an
isolated database.
