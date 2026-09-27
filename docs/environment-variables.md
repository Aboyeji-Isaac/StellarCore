# Environment Variables Reference

This document provides a comprehensive reference of all environment variables used by StellarCore across runtime, deployment, build, and test environments.

---

## Quick Reference Summary

| Variable Name | Required | Scope | Purpose | Default / Fallback | Safe Example Value |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `DATABASE_URL` | **Required** | Runtime / Build / Migrations | Direct PostgreSQL connection string used by Prisma ORM and the PostgreSQL client. | None (Throws `PrismaConfigEnvError` if absent) | `postgresql://postgres:postgres@localhost:5432/stellarcore_dev` |
| `CRON_SECRET` | **Required in Prod** / Optional in Dev | Runtime (Cron / Scheduled API) | Bearer secret token used to authenticate automated invocations of scheduled cron routes (`/api/scheduled/*`). | `undefined` (Reject requests when unset in prod) | `sec_test_random_hex_key_32_bytes_safe` |
| `NODE_ENV` | Optional | Runtime / Framework | Specifies the environment execution mode (`production`, `development`, `test`). | `development` | `production` |
| `RUN_DATABASE_INTEGRATION` | Optional | Integration Tests | Opt-in flag to run live PostgreSQL integration tests for Stellar anchor endpoints. | `0` (Disabled / Skipped) | `1` |
| `RUN_REPUTATION_DATABASE_INTEGRATION` | Optional | Integration Tests | Opt-in flag to run live PostgreSQL integration tests for the reputation engine. | `0` (Disabled / Skipped) | `1` |
| `RUN_REPUTATION_API_DATABASE_INTEGRATION` | Optional | Integration Tests | Opt-in flag to run live PostgreSQL integration tests for reputation API endpoints. | `0` (Disabled / Skipped) | `1` |

---

## Detailed Variable Specifications

### 1. `DATABASE_URL`
- **Required:** Yes
- **Usage Locations:** `lib/dbClient.ts`, `prisma.config.ts`, Prisma migrations (`deploy-production-migrations.yml`, `bootstrap-production-registry.yml`)
- **Description:** Direct PostgreSQL connection string required for application queries, schema migrations, and registry bootstrap scripts. Supports direct connections with pooled connection string adapters where configured.
- **Security:** Sensitive credentials (username, password, database host). Never commit to source control. In production and GitHub Actions, configure as a secure environment secret.
- **Example Value:** `postgresql://postgres:postgres@localhost:5432/stellarcore_dev`

---

### 2. `CRON_SECRET`
- **Required:** Yes in Production; Optional in Local Development
- **Usage Locations:** `lib/scheduled/cronAuth.ts`
- **Description:** A cryptographically secure random token used to authorize incoming HTTP requests from Vercel Cron or automated schedulers against `/api/scheduled/rates` and `/api/scheduled/sync`. Verified against the `Authorization: Bearer <token>` header.
- **Behavior when missing:** If unset in development, local manual triggers without authorization may be permitted or rejected based on environment settings. In production, requests lacking a matching bearer token return HTTP 401 Unauthorized.
- **Security:** Highly sensitive. Must never be exposed to the client or browser bundle.
- **Example Value:** `sec_test_sample_cron_secret_abcdef1234567890`

---

### 3. `NODE_ENV`
- **Required:** No (Defaults to `development`)
- **Usage Locations:** `lib/dbClient.ts`, Next.js runtime
- **Description:** Defines runtime optimizations and logging levels. When not equal to `production`, `lib/dbClient.ts` preserves the database client instance on the global object across Next.js Hot Module Replacement (HMR) reloads to prevent database connection pool exhaustion.
- **Allowed Values:** `development`, `production`, `test`
- **Example Value:** `production`

---

### 4. Integration Test Opt-In Flags

These variables enable live database integration tests that require an active PostgreSQL instance. By default in CI and standard test runs, these tests are skipped unless explicitly set.

#### `RUN_DATABASE_INTEGRATION`
- **Required:** No
- **Usage Locations:** `tests/integration/stellar/anchorsApi.database.integration.test.ts`
- **Description:** Set to `1` to run live database integration tests for Stellar anchor resolution and registry APIs.
- **Example Value:** `1`

#### `RUN_REPUTATION_DATABASE_INTEGRATION`
- **Required:** No
- **Usage Locations:** `tests/integration/reputation/reputationEngine.database.integration.test.ts`
- **Description:** Set to `1` to run live database integration tests for reputation scoring and outcome verification.
- **Example Value:** `1`

#### `RUN_REPUTATION_API_DATABASE_INTEGRATION`
- **Required:** No
- **Usage Locations:** `tests/integration/reputation/reputationApi.database.integration.test.ts`
- **Description:** Set to `1` to run live database integration tests for the HTTP reputation API routes.
- **Example Value:** `1`

---

## Setup & Local Development

1. Copy `.env.example` to `.env.local`:
   ```bash
   cp .env.example .env.local
   ```
2. Populate `DATABASE_URL` with your local PostgreSQL connection string.
3. Keep `.env.local` untracked in `.gitignore`.
