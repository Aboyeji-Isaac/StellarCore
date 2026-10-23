# Dynamic Project Memory

## Database foundation

- Commit `30bb6fa` established Prisma 7 with PostgreSQL, the generated-client
  singleton in `lib/db.ts`, and migration `20260818140749_init`.
- The initial schema has six models: `Anchor`, `Corridor`, `AnchorCorridor`,
  `RateSnapshot`, `TransferOutcome`, and `ReputationScore`. Entity IDs and
  foreign keys use native PostgreSQL UUIDs.
- Quote rate, source amount, destination amount, and fee use
  `Decimal(38,18)`. Freshness is derived from `capturedAt`; neither `isStale`
  nor a computed-median model is persisted.
- Runtime access uses `DATABASE_URL`; Prisma CLI operations use `DIRECT_URL`.
  Both must be direct PostgreSQL URLs for the current PrismaPg adapter setup.
- Known limitation: Prisma scalar-list declaration for `Anchor.seps` produces a
  defaulted PostgreSQL integer array without an explicit `NOT NULL` in the
  initial migration. Application writes maintain the intended array value.
- The migration and current schema have been applied and validated locally;
  Prisma generation, type-checking, tests, lint, and production build pass.

## Anchor Registry

- Commit `e1d1fee` added a minimal identity-only registry containing MoneyGram
  and Cowrie. Capabilities remain discovery results rather than registry claims.
- Central SEP constants are 1, 6, 10, 24, 31, and 38. Transfer capability is
  limited to SEP-6, SEP-24, or SEP-31.
- Registry validation requires normalized unique slugs, non-empty names, and
  safe normalized home domains; duplicate or malformed entries fail fast.
- Next steps must add anchors from verified identity data and must not infer
  protocol support in the static registry.

## SEP-1 Discovery

- Commits `aa6e696` and `73e5585` added `smol-toml` parsing and live
  `stellar.toml` discovery with typed, normalized, immutable results.
- SEP-1 is always present after valid discovery. Endpoint fields detect SEP-6,
  SEP-10, SEP-24, SEP-31, and SEP-38; `transferCapable()` checks only 6/24/31.
- Network boundaries enforce HTTPS-safe home domains, timeouts, bounded bodies,
  redirect rejection, typed HTTP/parse failures, and safe error reporting.
- Verified discovery produced MoneyGram `[1,10,24]` and Cowrie `[1,6,10,31]`.
  Neither result advertised SEP-38, so later rate work cannot infer it.

## Anchor Sync

- Commit `f28b712` maps a discovered anchor to the Prisma `Anchor` fields and
  upserts by stable slug. Successful discovery/persistence sets status `LIVE`.
- A failed refresh marks an existing anchor `DOWN` without replacing its last
  known metadata. A never-synchronized failure creates no row.
- Discovery and persistence failures are isolated per anchor and returned as
  safe structured results; one failure does not stop later anchors.
- Repeated runs are idempotent. MoneyGram and Cowrie were persisted through the
  sync flow; future automation still needs an explicit scheduler/runner.

## Corridor Registry

- Commit `10451de` added `usdc-us-usd-us` for MoneyGram and
  `ngnt-ng-ngn-ng` for Cowrie, with explicit anchor-to-corridor mappings.
- Unsupported or inferred USDC-to-NGN coverage was deliberately rejected; a
  corridor requires evidence instead of combining unrelated anchor assets.
- Corridor upserts and junction creation are idempotent. Association sync
  validates both sides, removes stale junctions, and isolates mapping failures.
- Future corridor additions must update and validate both the corridor registry
  and its evidence-backed anchor mappings.

## SEP-38 Discovery and Client

- Commit `416768c` implemented SEP-38 Draft v2.5.0 discovery from
  `ANCHOR_QUOTE_SERVER`, including identifiers for Stellar assets, liquidity
  pools, and ISO-4217 assets.
- Supported operations are `/info`, `/prices`, `/price`, `POST /quote`, and
  `GET /quote/:id`, with exact decimal strings preserved across boundaries.
- Production verification against Zeam found USDC↔BRL support. Indicative-price
  responses may adjust requested amounts when fees apply, so returned amounts
  are authoritative. No production firm quote was requested.
- HTTPS validation, redirect rejection, bounded JSON bodies, timeouts, exact
  content/status handling, token-safe errors, and quote/request correlation are
  enforced. This milestone performed discovery/client work only: no snapshots
  or medians were persisted.

## SEP-10 Authentication Boundary

- Commit `66a814d` implemented SEP-10 Active v3.4.1 behind the generic
  `StellarAuthProvider` boundary. SEP-45 Draft v0.1.1 is recognized as a future
  provider protocol but is not implemented.
- Challenge verification/signing uses `@stellar/stellar-sdk` and a caller-owned
  signer. StellarCore neither owns nor stores secret seeds.
- Returned JWTs must be bounded, well-formed, unexpired, issued before expiry,
  not issued more than five minutes in the future, and correlated to the
  expected subject and safe HTTPS issuer metadata. Provider errors are redacted.
- Zeam advertises `WEB_AUTH_ENDPOINT` and `SIGNING_KEY`, but no live production
  authentication was attempted. Production firm quotes remain out of scope.

## SEP-10 Integration Harness

- Commit `910dc23` added an opt-in live verifier for the official
  `testanchor.stellar.org` testnet anchor and an offline controlled integration
  harness for normal tests.
- The live flow completed SEP-1 discovery, challenge retrieval, local signing,
  challenge submission, and JWT validation with an ephemeral in-memory keypair.
  The account did not require Friendbot funding.
- Secrets, challenge XDR, JWTs, and authorization headers are neither printed
  nor persisted. No live SEP-38 firm quote is made.
- `npm run verify:sep10` runs the live check explicitly; it is excluded from
  tests, builds, and postinstall. Offline integration covers success and trust,
  signer, token, endpoint, timeout, and SEP-38-composition failure boundaries.

## 2026-08-27 — Rate Engine reconstruction

The Rate Engine milestone was reconstructed on the replacement laptop on the
`feat/rate-engine` branch.

- Financial values use exact BigInt-backed decimal parsing, comparison,
  sorting, and median averaging; no JavaScript `Number` conversion is used.
- Rate snapshots honor PostgreSQL `Decimal(38,18)` bounds.
- A rate is fresh through the exact 120,000 ms boundary and stale only after
  it. Future and invalid timestamps are explicit excluded states.
- Median computation excludes stale/future/invalid timestamps and invalid
  rates. Fewer than two fresh valid sources yields
  `insufficient_fresh_sources` with a null median. Medians are not persisted.
- Rate snapshots are append-only historical observations. Stable anchor and
  corridor slugs must resolve to an existing `AnchorCorridor` association;
  persistence never creates registry entities or associations.
- Each source failure is isolated by quote, normalization, or persistence
  phase, and duplicate candidates are skipped within one engine run.
- Current live eligible registry mappings remain zero: MoneyGram and Cowrie do
  not advertise `ANCHOR_QUOTE_SERVER`. SEP-38 support is never inferred.
- The engine is manual and injected-boundary driven. No scheduling, API route,
  or live polling job exists yet.

## 2026-08-27 — Live Rate Source

- Added Zeam (`zeam.money`) as a minimal identity-only production anchor after
  re-verifying its live TOML organization as ZEAM LIMITED. The TOML advertises
  SEP-10, SEP-24, SEP-31, SEP-38, `ANCHOR_QUOTE_SERVER`, and mainnet operation.
- Live SEP-38 `/info` and `/prices` re-verified the exact Circle Stellar USDC
  identifier ↔ `iso4217:BRL` pair. The reviewed candidate uses USDC→BRL,
  `sell_amount=100`, PIX, country `BR`, and context `sep31`.
- Added corridor `usdc-us-brl-br` and only the explicit Zeam mapping. The
  corridor schema records codes/countries but not issuers; the reviewed source
  retains and validates the full Circle USDC issuer identifier before quoting.
- Zeam TOML currently includes an empty optional `anchor_asset` on one currency;
  SEP-1 parsing now treats only that empty optional asset-metadata value as
  absent. Endpoint and required-string validation remain strict.
- `npm run snapshot:rates` is manual and opt-in. It performs live discovery and
  `/prices` pair verification, requests only unauthenticated indicative
  `/price`, runs the Rate Engine, and prints a redacted structured summary.
- Registry sync persisted one Zeam row, one corridor row, and one association.
  Two manual runs appended snapshots `491eccc7-e2e1-4fe9-ac8f-8f34e11a6062`
  and `e4513399-6dfe-4afd-a155-600d77afd18f`; count moved 0→1→2 while registry
  counts stayed at one. Both normalized observations were rate `0.17`, source
  `100` USDC, destination `17` BRL, and destination-denominated fee `1` BRL.
- With one independent live anchor source, median state is
  `insufficient_fresh_sources`, median is null, and fresh source count is one.
- No firm quote, authentication, scheduler, polling loop, API, frontend, or
  reputation work was added. Live Node connectivity may fail transiently even
  when the endpoint is healthy; command failures remain safe and non-secret.
- Recommended next milestone: expose a manual/read-only backend rate query that
  selects the latest snapshot per anchor while preserving issuer-aware source
  configuration and the two-source median threshold.

### Final pre-commit review

- Final review found all ten tracked modifications scoped to the Live Rate
  Source milestone; no tracked change required reversion.
- `lib/dbClient.ts` remains the sole Prisma client singleton. `lib/db.ts` is a
  server-only Next.js re-export, while standalone `tsx` maintenance paths use
  the unguarded runtime module; no duplicate client is created.
- Verification passed: Prisma validate and migration status, TypeScript,
  83 Vitest tests, lint, production build, and `git diff --check`.
- The two existing development `RateSnapshot` rows remain distinct and intact;
  this review created no additional live observations.
- Commit readiness: ten tracked files are modified and six milestone files are
  untracked, with nothing staged. Dynamic memory remains gitignored.


## 2026-08-27 — Latest Rate Read Model

- Added a backend-only, read-only corridor rate composition:
  `RateSnapshot` history → one latest row per anchor → read-time freshness →
  exact existing median → immutable safe result. It performs no quote fetch or
  database mutation.
- The Prisma repository resolves a corridor by stable slug and uses one
  parameterized PostgreSQL `DISTINCT ON (anchor_id)` query. Rows are ordered by
  `captured_at DESC`, then persisted snapshot UUID `DESC`; the lexicographically
  greater UUID deterministically wins identical timestamps.
- The pure composition defensively repeats latest-per-anchor selection for
  injected repositories. Selection always precedes freshness evaluation and
  never falls back to an older observation because the latest row is unusable.
- Freshness reuses `getRateFreshness` with an explicit evaluation time:
  age through 120,000 ms is fresh, greater age is stale, and future/invalid
  timestamps are excluded. Freshness is not persisted.
- Median calculation reuses the exact BigInt-backed implementation and the
  two-independent-source threshold. Zero or one fresh source yields
  `insufficient_fresh_sources` and a null median; medians are not persisted.
- `npm run verify:latest-rates` is an opt-in local database read. At
  `2026-08-27T14:08:42.162Z`, the two historical Zeam rows collapsed to the
  later snapshot `e4513399-6dfe-4afd-a155-600d77afd18f`, captured at
  `2026-08-27T12:03:03.454Z`. It was stale (age 7,538,708 ms), so the result had
  one independent source, zero fresh sources, null median, and
  `insufficient_fresh_sources`.
- Development `RateSnapshot` count remained 2→2. No SEP-38 request, registry
  mutation, snapshot write, API, frontend, scheduler, or reputation work ran.
- Known limitations: the efficient latest-row query is PostgreSQL-specific and
  the reviewed corridor still has only one independent anchor, so it cannot
  produce a healthy median. No new index was needed at current project scale.
- Recommended next milestone: review and add a second genuinely independent
  production source for the corridor before exposing the read model publicly.

## 2026-08-28 — Rates API

- Added read-only `GET /api/rates?corridor=<slug>` with the dependency flow:
  App Router handler → API service/serializer → existing latest-rate read model
  → existing PostgreSQL repository. The API reads persisted snapshots only and
  never performs live SEP-38 requests or database writes.
- Both `healthy` and `insufficient_fresh_sources` are successful HTTP 200 data
  states. `medianRate` is null whenever fewer than two fresh valid independent
  sources exist; no fallback rate or persisted median was introduced.
- Stable safe errors are `missing_corridor` and `invalid_corridor` (HTTP 400),
  `corridor_not_found` (HTTP 404), and `internal_error` (HTTP 500).
- Freshness uses one evaluation timestamp per request. The route is dynamic and
  returns `Cache-Control: no-store`, preventing cached responses from masking
  changes in source age.
- Public serialization preserves financial decimals as strings and omits
  snapshot UUIDs, Prisma values, BigInt values, SQL details, raw exceptions,
  stack traces, and environment data.
- Manual verification of `usdc-us-brl-br` returned HTTP 200 with one independent
  Zeam source, zero fresh sources, `insufficient_fresh_sources`, and a null
  median. No live quote request or data mutation occurred.
- Verification completed with 99/99 tests passing. Prisma validation and
  migration status, TypeScript, lint, production build, and whitespace checks
  passed. No schema, migration, generated Prisma, frontend, scheduler, new
  source, authentication, or reputation changes were made.
- Known limitation: a second genuinely independent production source must be
  verified and ingested before the real corridor can produce a healthy median.
- Recommended next milestone: expose a read-only corridor directory, or add
  API observability and rate limiting while keeping ingestion separate from
  public GET requests.

## 2026-08-31 — Corridors API

- Added read-only `GET /api/corridors` with the dependency flow: App Router
  handler → corridor API service/serializer → dedicated Prisma repository →
  persisted `Corridor` and `AnchorCorridor` state. It performs no writes, rate
  reads, rate ingestion, or live Stellar/SEP requests.
- Persisted corridors are the public source of truth. The reviewed static
  registry remains synchronization input and cannot make an unsynchronized
  corridor appear in the directory.
- The stable response is `{ corridors, count }`. Each JSON-safe corridor has
  only slug, source/destination asset and country codes, and `anchorCount`.
  Database UUIDs, join IDs, timestamps, Prisma objects, errors, and secrets are
  omitted. Results and nested DTOs are immutable.
- `anchorCount` counts synchronized `AnchorCorridor` associations only. It is
  not a fresh rate source count, healthy median count, or online quote count.
- The repository uses one bounded Prisma `findMany` query selecting only public
  corridor fields plus the `anchors` relation count. It loads no snapshots and
  performs no N+1 queries. Prisma orders by slug ascending, and serialization
  repeats the sort defensively for injected repositories.
- Empty persisted state returns HTTP 200 with `{"corridors":[],"count":0}`.
  Repository failures return the existing safe API convention: HTTP 500 with
  `internal_error` and `Unable to load corridors.`
- The route is request-dynamic and returns `Cache-Control: no-store`, matching
  the conservative current API policy while exposing database changes without
  accidental framework caching.
- Manual local verification returned HTTP 200 and three persisted corridors in
  slug order: `ngnt-ng-ngn-ng`, `usdc-us-brl-br`, and `usdc-us-usd-us`. Each
  had `anchorCount: 1`; `count` was 3. Prisma migration status was current.
- Added deterministic unit and controlled integration coverage for empty, one,
  and multiple corridors, ordering, association counts, immutable JSON-safe
  serialization, ID omission, safe repository failure, and GET-only routing.
  The complete offline suite passed 105/105 tests before final verification.
- Known limitation: association count communicates synchronized membership,
  not operational or rate health. Consumers must query `/api/rates` separately
  when they need persisted rate freshness and median state.
- Recommended next milestone: implement a read-only public anchor directory,
  or add API observability and rate limiting without coupling reads to sync or
  ingestion.

## 2026-08-31 — Anchors API

- Added read-only `GET /api/anchors` and `GET /api/anchors/[slug]` with the
  dependency flow: App Router handlers → anchor API service/serializers → a
  dedicated Prisma repository → persisted `Anchor` and `AnchorCorridor` state.
- Persisted anchors are the sole public source of truth. The hardcoded registry
  remains synchronization input, so registry-only identities are never exposed
  until synchronization creates an `Anchor` row.
- List responses use `{ anchors, count }`, sort by slug, expose only slug, name,
  home domain, persisted status, sorted stored SEP numbers, and synchronized
  corridor count. Detail responses use `{ anchor }` and add only public fields
  for associated persisted corridors, sorted by slug.
- Persisted status communicates the last synchronization/discovery condition,
  not guaranteed current quote health. GET requests make no live SEP call and
  do not refresh status. SEP capabilities are stored discoveries only and are
  never inferred from endpoints, registry data, or corridor membership.
- Slugs must be 1–100 lowercase alphanumeric characters with single hyphen
  separators. Validation occurs before repository access. Stable safe errors
  are `invalid_anchor_slug` (400), `anchor_not_found` (404), and
  `internal_error` (500).
- Both routes are request-dynamic and return `Cache-Control: no-store`. They are
  GET-only and perform no writes, synchronization, authentication, rate reads,
  or live Stellar/SEP requests.
- The list repository uses one bounded `findMany` selecting public fields plus
  the `AnchorCorridor` count. Detail uses one bounded `findUnique` selecting
  public anchor fields and nested corridor public fields. Neither query loads
  snapshots, outcomes, reputation, timestamps, UUIDs, or join IDs; there is no
  N+1 query.
- Manual development responses: `/api/anchors` returned HTTP 200 with Cowrie,
  MoneyGram, and Zeam in slug order, each with `corridorCount: 1`;
  `/api/anchors/zeam` returned HTTP 200 with stored status `LIVE`, SEPs
  `[1,10,24,31,38]`, and corridor `usdc-us-brl-br`;
  `/api/anchors/not-a-real-anchor` returned HTTP 404 with `anchor_not_found`.
  Every response sent `Cache-Control: no-store`.
- Added unit, controlled offline integration, and isolated opt-in local database
  integration coverage. The database fixture uses unique slugs and deletes only
  its own junction, anchor, and corridor, leaving development records untouched.
  The database-enabled suite passed 117/117 tests.
- Known limitations: status is not a live health probe, SEP data is only as
  current as the last successful sync, and corridor membership says nothing
  about current rate freshness or availability.
- Recommended next milestone: add public API observability and scoped rate
  limiting, while keeping anchor synchronization and live discovery separate
  from request-time reads.

## 2026-08-31 — Reputation Engine

- Added a deterministic reputation pipeline: persisted evidence repository →
  normalized immutable evidence → pure calculation → optional current-score
  upsert. There is no route, frontend, scheduler, network call, or schema change.
- The existing schema is usable and intentionally defines current-state rather
  than history: `ReputationScore.anchorId` is unique, so calculations upsert one
  row per anchor. `INSUFFICIENT_DATA` and `OK` remain the persisted evidence
  states; unsupported confidence enums were not invented.
- The 0–100 formula is availability 20%, latest-rate freshness 15%, fresh
  synchronized-corridor coverage 15%, and 90-day completed-transfer reliability
  50%. Missing evidence earns zero and weights are never redistributed.
- A composite is withheld unless the anchor has at least 30 outcomes in the
  trailing 90 days, at least one synchronized corridor, and at least one latest
  persisted rate observation. Only `COMPLETED` is success; all other outcome
  statuses count as failure. Sparse state persists null score and band.
- Freshness reuses `getRateFreshness` and `RATE_FRESHNESS_THRESHOLD_MS`, selects
  one latest observation per synchronized corridor, and uses one explicit
  timestamp for the entire calculation. Count ratios use integer basis points
  and half-up rounding; bounded non-financial persisted ratios use explicit
  decimal conversion. No financial rate value enters the score.
- Explanatory persisted metrics are completed ratios for 7/30/90 days and
  nearest-rank settlement/slippage p50/p95 over completed outcomes in 30 days.
  They are not opaque score inputs.
- Local verification at `2026-08-31T13:54:34.979Z` found Cowrie and MoneyGram
  `LIVE`, one corridor, zero latest rates, and zero outcomes. Zeam was `LIVE`
  with one corridor, one stale latest rate, zero fresh rates, and zero outcomes.
  All three correctly produced `insufficient_evidence`, null score, and null
  band. Current score count changed 0→3; a second run changed 3→3 and retained
  the same row IDs, confirming upsert rather than append semantics.
- Added deterministic unit, controlled integration, and isolated opt-in local
  database coverage for sparse/status-only evidence, freshness boundaries,
  mixed coverage, every outcome mix, minimum sample transition, exact weights,
  bounds, rounding, immutability, safe failures, and current-row persistence.
  Final normal suite: 129 passed, 2 opt-in database tests skipped (131 total);
  the isolated reputation database test passed separately 1/1.
- Known limitations: synchronized status is not live health; current rows do not
  provide score history; transfer reliability requires intentionally recorded
  outcomes; settlement speed and slippage are explanatory only in v1.
- Recommended next milestone: add a read-only public reputation API exposing the
  current calculation and evidence state, without request-time recomputation.

## 2026-08-31 — Reputation API

- Added read-only `GET /api/reputation` and `GET /api/reputation/[slug]` with
  the flow: route handler → reputation API serializer/service → dedicated public
  repository → persisted `Anchor` plus optional current `ReputationScore`.
  Neither route imports or calls the engine/evidence repository, reads snapshots
  or outcomes, writes data, synchronizes, authenticates, or makes network calls.
- The list includes every persisted anchor in slug order. An anchor with no
  `ReputationScore` is HTTP 200 `not_evaluated` with null score, band, evidence,
  metrics, and computed timestamp. This distinguishes no evaluation from a
  missing anchor, which remains `anchor_not_found` (404).
- Persisted states map exactly: `INSUFFICIENT_DATA` → `insufficient_evidence`
  and `OK` → `established`. Sparse rows preserve null score and band; the API
  never converts null to zero or reconstructs a score. Persisted bands are
  serialized as lower-case `green`, `amber`, or `red`.
- Public evaluated rows contain safe anchor identity, state, bounded score,
  persisted sample size as `evidence.outcomeCount`, persisted 7/30/90-day fill
  rates and settlement/slippage percentiles as metrics, plus ISO `computedAt`.
  Component weights and corridor/freshness counts are deliberately absent: the
  current `ReputationScore` schema does not store them.
- Repository queries are one bounded `Anchor.findMany` list or `Anchor.findUnique`
  detail with a select-only optional score relation. There is no N+1, UUID/join
  leakage, raw enum leakage, or score/evidence-history query.
- Local manual verification: `/api/reputation` returned Cowrie, MoneyGram, and
  Zeam in slug order (count 3). Each detail endpoint returned HTTP 200
  `insufficient_evidence`, null score/band, outcomeCount 0, null metrics, and
  computedAt `2026-08-31T13:54:41.719Z`; an unknown slug returned HTTP 404
  `anchor_not_found`. Responses sent `Cache-Control: no-store`.
- Added deterministic unit, controlled integration, and isolated opt-in database
  coverage for empty lists, unevaluated and sparse/established rows, mapping,
  null preservation, ordering, JSON safety, validation-before-access, safe
  errors, GET-only behavior, current-row reads, and scoped fixture cleanup.
  Normal suite passed 137 with 3 opt-in database tests skipped (140 total);
  isolated Reputation API database coverage passed 1/1.
- Known limitation: this exposes only the latest current score row, not a score
  timeline or transient engine component breakdown. `computedAt` is not current
  operational health.
- Recommended next milestone: add score-history storage only after an explicit
  schema design, or add API observability/rate limiting without coupling reads
  to reputation calculation.
## 2026-09-01 — Scheduled Refresh
- Added the authenticated `GET /api/internal/cron/refresh` boundary with the
  sequence: reviewed indicative rate-snapshot runner → persisted reputation
  evaluation. Rate preparation failure is safe and isolated; fatal reputation
  orchestration failure reaches the HTTP boundary as a safe 500 response.
- The route requires exactly `Authorization: Bearer <CRON_SECRET>`. It uses a
  SHA-256 digest and Node `timingSafeEqual`; it does not support query-string
  credentials and returns neither credentials, exceptions, nor raw Prisma data.
- Local Prisma Dev verification on 2026-09-01 used a temporary shell-only secret.
  Missing and invalid Bearer headers both returned 401 `unauthorized` with
  `Cache-Control: no-store` and made no writes. One authorized run returned 200:
  `{ok:true, rates:{attempted:1,succeeded:1,failed:0,skipped:0}, reputation:{attempted:3,succeeded:3,failed:0}}`.
- RateSnapshot count changed 2→3, confirming the successful indicative observation
  was appended. ReputationScore remained 3→3 while all three anchors evaluated,
  confirming the current-row upsert behavior. No firm SEP-38 quote was used.
- Cowrie, MoneyGram, and Zeam all remain `INSUFFICIENT_DATA` (publicly
  `insufficient_evidence`) with null score/band and zero outcomes. This is valid
  sparse evidence; no data was manipulated to produce an established score.
## 2026-09-01 — Deployment Readiness
- Prepared Vercel/managed-PostgreSQL deployment without provisioning, deploying,
  connecting an account, or using production credentials.
- Prisma 7 now reads `DATABASE_URL` in `prisma.config.ts`, matching the direct
  `PrismaPg` runtime adapter. `DIRECT_URL` is removed from the tracked template.
- Production migrations run only as `npx prisma migrate deploy` in protected CI
  or a release step, never normal Vercel builds or previews.
- Exact production variables are server-only `DATABASE_URL` and `CRON_SECRET`.
  Node.js is pinned to Vercel-supported `22.x`; postinstall remains `prisma generate`.
- Added idempotent explicit `npm run bootstrap:registry` for first anchors,
  corridors, and associations; it is not wired into requests, builds, or cron.
- Added one production Vercel cron at `*/10 * * * *` for the existing refresh
  route. Vercel sends the secret in the Bearer header; no query secret is used.
- Added `docs/DEPLOYMENT.md` and README/AGENTS guidance for previews, migration,
  bootstrap, verification, rollback, duration limits, and manual release steps.
- Remaining manual work: provision database, set production-only variables, run
  the protected migration/bootstrap, connect Vercel, and verify public endpoints.

## 2026-09-09 — Production Migration Workflow

- Added `.github/workflows/deploy-production-migrations.yml`, the first file
  under `.github/`. It implements the previously documented protected migration
  step as a GitHub Actions workflow.
- Trigger is `workflow_dispatch` only — no `push`, no `pull_request`, no
  `schedule`, and it is deliberately decoupled from Vercel builds so previews
  cannot mutate production.
- The single `migrate` job runs on `ubuntu-latest`, checks out the repo, sets up
  Node.js 22 with npm cache, runs `npm ci` (whose existing `postinstall` runs
  `prisma generate`, so there is no separate generation step), and then runs
  exactly `npx prisma migrate deploy`. No `migrate dev`, `db push`, or reset.
- The job declares `environment: production`. A repository admin must create a
  GitHub Actions environment named `production` and add a `DATABASE_URL`
  environment secret (direct PostgreSQL URL for Prisma Migrate) before the first
  run; optional required reviewers/protection rules can be attached to that
  environment. The secret must never be placed in a repository file.
- `DATABASE_URL` is passed to the migrate step as
  `${{ secrets.DATABASE_URL }}` and is the only secret consumed. No Vercel CLI,
  Vercel token, `CRON_SECRET`, `POSTGRES_URL`, or `PRISMA_DATABASE_URL`. No
  step prints the secret and there are no env-dumping debug steps.
- Concurrency: group `production-database-migration` with
  `cancel-in-progress: false`, so two production migration runs can never
  overlap and an in-progress migration is never cancelled by a new trigger.
- Permissions: least-privilege top-level `contents: read` only. Job timeout is
  `timeout-minutes: 10`, conservative for the current single-migration history.
- Documentation: added a "Production migration workflow (GitHub Actions)"
  section to `docs/DEPLOYMENT.md` (settings → `production` environment →
  `DATABASE_URL` secret → optional reviewers → Actions → run workflow → confirm
  `prisma migrate deploy` → then bootstrap/deploy) and a one-line pointer in the
  README production-deployment section.
- No production migration has been executed. Nothing was committed, pushed,
  merged, or deployed; no GitHub secret or environment was created; the
  production database was not touched.
- Remaining next step after this branch is merged: a repository admin creates
  the `production` environment and `DATABASE_URL` secret, then runs the workflow
  manually once to apply `20260818140749_init`, and only then proceeds to
  `npm run bootstrap:registry` and the Vercel deployment.

### 2026-09-09 — Post-shutdown recovery verification

- The laptop shut down mid-milestone. On recovery the working tree already held
  the complete milestone: untracked `.github/workflows/deploy-production-migrations.yml`
  plus modified `README.md` and `docs/DEPLOYMENT.md`, nothing staged/committed.
  No partial or truncated edits were found; no existing work was redone or
  overwritten.
- Re-audited the workflow against every required constraint (trigger, environment,
  Node 22, `npm ci`, secret-only `DATABASE_URL`, exact `npx prisma migrate deploy`,
  `contents: read`, `production-database-migration` concurrency,
  `cancel-in-progress: false`, 10-minute timeout, no push/PR trigger, no Vercel
  CLI, no `CRON_SECRET`): all satisfied. Structural YAML validation with PyYAML
  passed (24/24 substantive assertions; the sole flagged item was the word
  "Vercel" appearing only in an explanatory comment, not as a CLI/action/token).
- Full verification suite passed: `npm ci` (postinstall `prisma generate` ran),
  `npx prisma validate` (schema valid), `npx tsc --noEmit` (no errors),
  `npm test` (149 pass, 0 fail, 3 opt-in DB tests skipped; 152 total),
  `npm run lint` (clean), `npm run build` (Next.js build succeeded, 7 API routes
  dynamic), `git diff --check` (clean), workflow file whitespace/newline clean.
- No commit, push, merge, workflow run, secret creation, or production migration
  was performed. Milestone is code-complete and verified; only the documented
  manual GitHub setup + first manual run remain.

### 2026-09-10 — Migration workflow `npm ci` fix

- The manual `Deploy production migrations` workflow was merged and dispatched
  for the first time. It failed before any migration ran: the "Install
  dependencies" step (`npm ci`) exited with
  `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`.
- Cause: `package.json` `postinstall` runs `prisma generate`, which loads
  `prisma.config.ts`, and that config resolves `DATABASE_URL` at load time. The
  workflow supplied the secret only to the later "Apply migrations" step, so the
  install step had no value to resolve.
- Fix (minimal): added `env: DATABASE_URL: ${{ secrets.DATABASE_URL }}` to the
  "Install dependencies" step and kept the identical env block on "Apply
  migrations". The secret was deliberately not hoisted to workflow-level `env`;
  step scoping keeps it out of `checkout` and `setup-node`. Nothing echoes it.
- Not changed: `prisma.config.ts`, schema, migrations, package scripts, Vercel
  config, application code. No additional secrets. Trigger remains
  `workflow_dispatch` only, `permissions: contents: read`, `environment:
  production`, concurrency `production-database-migration` with
  `cancel-in-progress: false`, Node 22, 10-minute timeout.
- `docs/DEPLOYMENT.md` now states that the `production` `DATABASE_URL` secret is
  required during dependency installation as well, and why.
- Nothing was committed, pushed, merged, or re-dispatched; no secret rotation,
  no Vercel change, no production migration.

### 2026-09-10 — Production registry bootstrap workflow

- Added `.github/workflows/bootstrap-production-registry.yml`: a manual
  (`workflow_dispatch` only) GitHub Actions workflow that runs the one-time
  production registry bootstrap. No push/pull_request/schedule/deployment or
  any automatic trigger. Not combined with the migration workflow; no automatic
  bootstrap added to any deployment.
- Job: `ubuntu-latest`, `actions/setup-node@v4` Node 22 with `cache: npm`,
  `environment: production`, `permissions: contents: read`,
  `timeout-minutes: 10`, concurrency group `production-registry-bootstrap` with
  `cancel-in-progress: false`.
- Steps: checkout → setup-node → `npm ci` → `npm run bootstrap:registry`. The
  install and bootstrap steps each get `DATABASE_URL: ${{ secrets.DATABASE_URL }}`
  step-scoped (not workflow/job level). `DATABASE_URL` is the only secret
  referenced. No echo/printenv/env-dump/debug; no Vercel CLI/token; no
  `CRON_SECRET`, `POSTGRES_URL`, or `PRISMA_DATABASE_URL`.
- Why `DATABASE_URL` during `npm ci`: `postinstall` runs `prisma generate`,
  which loads `prisma.config.ts`; that config resolves `env("DATABASE_URL")` at
  load time, so a missing value fails the install step with
  `PrismaConfigEnvError` before the bootstrap runs. Same reason as the
  migration workflow fix.
- Bootstrap semantics unchanged: `scripts/bootstrap-registry.ts` upserts the
  reviewed `ANCHOR_REGISTRY` / corridor registry via `syncAnchorRegistry` and
  `syncCorridorRegistry`, prints a safe JSON summary, and sets exit code 1 on
  any failure (`anchors.failed > 0` or `corridors.failures.length > 0`). No
  script/schema/migration/registry/sync/API/Vercel/app changes.
- Docs: `docs/DEPLOYMENT.md` gains a "Production registry bootstrap workflow
  (GitHub Actions)" section (idempotent, normally once per fresh DB, re-runnable
  after reviewed registry changes) and the "First production cycle" list now
  reads: 1) migration workflow, 2) registry bootstrap workflow, 3) app deploy,
  4) scheduled refresh, 5) public API verification. `README.md` production
  section now points at the bootstrap workflow.
- State when authored: migration `20260818140749_init` already applied to
  production; GitHub `production` environment + working `DATABASE_URL` secret
  already exist (shared with this workflow).
- Not done: no commit, push, merge, secret config, workflow dispatch, bootstrap
  run, production API call, or Vercel deploy. Remaining manual steps: merge the
  branch, then a repo admin opens Actions → **Bootstrap production registry** →
  Run workflow once, confirms the JSON summary and zero exit, then proceeds to
  the Vercel deployment and lets the scheduled refresh run.

### 2026-10-16 — Scheduled source-suppression CI repair

- Goal: restore the scheduled source-suppression CI path on `development`
  without changing migrations, network/TLS policy, dependencies, or production
  configuration.
- Completed: repaired the scheduler suppression seam so deterministic
  normalization failures are classified with the full failure object, transient
  quote failures remain visible, suppressed sources use the canonical
  `listSuppressed` API, and unit/in-memory integration fixtures match the
  durable `ACTIVE`/`SUPPRESSED` state model.
- Completed: reconciled `prisma/schema.prisma` to committed migration
  `20261001123000_add_scheduled_source_suppressions` and historical schema
  contract `c175e36`: slug-keyed source identity, no Anchor/Corridor foreign-key
  relations, `ACTIVE`/`SUPPRESSED` state, nullable suppression timestamp, and
  the canonical unique/state indexes. The migration itself was not changed.
- Validation: `npx prisma validate`, `npx prisma generate`, the four
  scheduled-suppression unit files (27 tests), and the in-memory scheduled
  integration file (2 tests) passed using a local non-production database URL.
- Remaining: `npx tsc --noEmit` is still blocked by unrelated source defects:
  missing `applyPermanentFailureSuppression`, missing `lib/db/sqlSafety`, and a
  `FailureClass` to `PermanentFailureClass` narrowing error in
  `lib/rates/freshness.ts`. Prisma delegate and `lastSyncOrder` type errors no
  longer occur after client generation. No commit, push, PR, migration
  application, production database access, or production configuration change
  was performed.

## 2026-10-23 — Dynamic project memory ownership and tracking

- Prepared PR #557, `security/dynamicmem-owner-guard`, to track this file in
  `Aboyeji-Isaac/StellarCore` and establish a dedicated ownership guard.
- The uploaded project history above was retained without rewriting. This
  section records the memory-tracking setup itself so future work has a clear
  audit trail.
- The PR removes only the `DynamicMem.md` ignore entry, adds an explicit
  `/DynamicMem.md @Aboyeji-Isaac` CODEOWNERS entry, and adds
  `.github/workflows/dynamicmem-owner-guard.yml`. The guard checks the
  authenticated GitHub event actor and GitHub-associated commit authors for
  changes to this file, its own workflow, and CODEOWNERS; it fails closed when
  it cannot verify attribution or the complete changed-file list.
- State at preparation time: PR #557 is open as a draft and remains unmerged.
  The new `pull_request_target` guard cannot run on this initial PR because
  GitHub loads that workflow from the base branch; it becomes active for future
  PRs after it is merged.
- Repository settings still need owner action: GitHub reports the
  `development` branch as unprotected, the visible rulesets list is empty,
  and the connected integration could not read or modify branch protection.
  A required status check, restricted push/bypass permissions, and enforced
  CODEOWNERS review must be configured before treating the file as protected.
- Validation so far: the repository copy was checked against the uploaded
  file before this tracking note was appended; the ignore rule and explicit
  CODEOWNERS entry were verified. No CI run was returned for the PR head at
  the time of this entry.
- No merge, direct write to `development`, production operation, database
  change, or unrelated CI modification was performed. Future implementation
  milestones, architectural decisions, test results, CI outcomes, and known
  defects should be appended here as verified facts rather than inferred.
