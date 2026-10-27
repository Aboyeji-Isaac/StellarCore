/**
 * Environment metadata construction across production, preview, and test
 * configurations.
 *
 * The metadata is what a consumer of public evidence reads to know which
 * environment served it. These tests use synthetic environment maps only (no
 * ambient machine state) and assert:
 *
 * 1. identity comes from trusted validated configuration, with lower-precedence
 *    ambient values unable to override it;
 * 2. missing or invalid configuration fails closed with a typed result instead
 *    of throwing or guessing;
 * 3. preview and test configurations never claim production identity by
 *    default;
 * 4. no sensitive environment variable value (or secret-shaped field name)
 *    appears in the metadata or in a failure result.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEnvironmentMetadata,
  ENVIRONMENT_METADATA_VERSION,
  resolveEnvironmentMetadata,
} from "@/lib/config/environmentMetadata";
import {
  createTestRuntimeConfig,
  type RuntimeConfig,
} from "@/lib/config/runtimeConfig";

const PRODUCTION_PASSWORD = "production-password-must-not-leak";
const PREVIEW_PASSWORD = "preview-password-must-not-leak";
const PRODUCTION_CRON_SECRET = "production-cron-secret-must-not-leak";

const PRODUCTION_URL = `postgresql://evidence:${PRODUCTION_PASSWORD}@db.example/stellarcore`;
const PREVIEW_URL = `postgresql://evidence:${PREVIEW_PASSWORD}@preview.example/stellarcore`;

const PRODUCTION_ENV = Object.freeze({
  STELLARCORE_ENVIRONMENT: "production",
  DATABASE_URL: PRODUCTION_URL,
  CRON_SECRET: PRODUCTION_CRON_SECRET,
});

const PREVIEW_ENV = Object.freeze({
  VERCEL_ENV: "preview",
  DATABASE_URL: PREVIEW_URL,
});

test("production metadata is derived from validated explicit configuration", () => {
  const result = resolveEnvironmentMetadata(PRODUCTION_ENV);

  assert.ok(result.ok);
  assert.deepEqual(result.metadata, {
    version: ENVIRONMENT_METADATA_VERSION,
    environment: "production",
    source: "explicit-env",
    isProduction: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.metadata), true);
  assert.doesNotThrow(() => JSON.stringify(result.metadata));
});

test("preview metadata reports preview and is never production", () => {
  const result = resolveEnvironmentMetadata(PREVIEW_ENV);

  assert.ok(result.ok);
  assert.equal(result.metadata.environment, "preview");
  assert.equal(result.metadata.source, "vercel-env");
  assert.equal(result.metadata.isProduction, false);
});

test("test, ci, and development configurations are isolated and non-production", () => {
  const cases: ReadonlyArray<Readonly<{
    env: Readonly<Record<string, string | undefined>>;
    environment: string;
    source: string;
  }>> = [
    { env: { NODE_ENV: "test" }, environment: "test", source: "test-default" },
    {
      env: { STELLARCORE_ENVIRONMENT: "ci", DATABASE_URL: PREVIEW_URL },
      environment: "ci",
      source: "explicit-env",
    },
    {
      env: { STELLARCORE_ENVIRONMENT: "development", DATABASE_URL: PREVIEW_URL },
      environment: "development",
      source: "explicit-env",
    },
    {
      env: { VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_URL, NODE_ENV: "production" },
      environment: "preview",
      source: "vercel-env",
    },
  ];

  for (const { env, environment, source } of cases) {
    const result = resolveEnvironmentMetadata(env);
    assert.ok(result.ok, `expected metadata for env ${JSON.stringify(env)}`);
    assert.equal(result.metadata.environment, environment);
    assert.equal(result.metadata.source, source);
    assert.equal(result.metadata.isProduction, false);
  }
});

test("identity follows trusted configuration precedence, not ambient values", () => {
  const precedence = resolveEnvironmentMetadata({
    STELLARCORE_ENVIRONMENT: "preview",
    VERCEL_ENV: "production",
    NODE_ENV: "production",
    DATABASE_URL: PREVIEW_URL,
  });

  assert.ok(precedence.ok);
  assert.equal(precedence.metadata.environment, "preview");
  assert.equal(precedence.metadata.source, "explicit-env");
  assert.equal(precedence.metadata.isProduction, false);

  const fromValidatedConfig = buildEnvironmentMetadata(
    createTestRuntimeConfig({ environment: "preview", environmentSource: "explicit-env" }),
  );
  assert.ok(fromValidatedConfig.ok);
  assert.equal(fromValidatedConfig.metadata.environment, "preview");
});

test("missing or invalid configuration fails closed without throwing", () => {
  const unavailableInputs: ReadonlyArray<Readonly<Record<string, string | undefined>>> = [
    {},
    { STELLARCORE_ENVIRONMENT: "staging", DATABASE_URL: PRODUCTION_URL },
    { STELLARCORE_ENVIRONMENT: "production", DATABASE_URL: PRODUCTION_URL },
    { STELLARCORE_ENVIRONMENT: "production" },
    { VERCEL_ENV: "preview" },
    { STELLARCORE_ENVIRONMENT: "   " },
  ];

  for (const env of unavailableInputs) {
    const result = resolveEnvironmentMetadata(env);
    assert.deepEqual(
      result,
      { ok: false, code: "ENVIRONMENT_METADATA_UNAVAILABLE" },
      `expected a safe failure for env ${JSON.stringify(env)}`,
    );
  }

  assert.deepEqual(buildEnvironmentMetadata(undefined), {
    ok: false,
    code: "ENVIRONMENT_METADATA_UNAVAILABLE",
  });
  assert.deepEqual(buildEnvironmentMetadata(null), {
    ok: false,
    code: "ENVIRONMENT_METADATA_UNAVAILABLE",
  });
});

test("untrusted configuration shapes are rejected rather than published", () => {
  const base = createTestRuntimeConfig();

  const untrusted: ReadonlyArray<Readonly<{ label: string; config: RuntimeConfig }>> = [
    {
      label: "unknown environment identity",
      config: { ...base, environment: "staging" } as unknown as RuntimeConfig,
    },
    {
      label: "unknown identity source",
      config: { ...base, environmentSource: "ambient-hostname" } as unknown as RuntimeConfig,
    },
    {
      label: "production claimed through the test-only default source",
      config: {
        ...base,
        environment: "production",
        environmentSource: "test-default",
      } as unknown as RuntimeConfig,
    },
  ];

  for (const { label, config } of untrusted) {
    assert.deepEqual(
      buildEnvironmentMetadata(config),
      { ok: false, code: "ENVIRONMENT_METADATA_INVALID" },
      label,
    );
  }
});

test("no non-production configuration can claim production identity by default", () => {
  const syntheticEnvironments: ReadonlyArray<Readonly<Record<string, string | undefined>>> = [
    { NODE_ENV: "test" },
    { NODE_ENV: "development" },
    { VERCEL_ENV: "preview", DATABASE_URL: PREVIEW_URL },
    { VERCEL_ENV: "development", DATABASE_URL: PREVIEW_URL },
    { STELLARCORE_ENVIRONMENT: "test" },
    { STELLARCORE_ENVIRONMENT: "ci", DATABASE_URL: PREVIEW_URL },
    { STELLARCORE_ENVIRONMENT: "development", DATABASE_URL: PREVIEW_URL },
    {},
  ];

  for (const env of syntheticEnvironments) {
    const result = resolveEnvironmentMetadata(env);
    if (!result.ok) {
      assert.equal(
        result.code,
        "ENVIRONMENT_METADATA_UNAVAILABLE",
        `unexpected failure code for env ${JSON.stringify(env)}`,
      );
      continue;
    }
    assert.notEqual(result.metadata.environment, "production");
    assert.equal(result.metadata.isProduction, false);
  }

  const testConfigMetadata = buildEnvironmentMetadata(createTestRuntimeConfig());
  assert.ok(testConfigMetadata.ok);
  assert.equal(testConfigMetadata.metadata.environment, "test");
  assert.equal(testConfigMetadata.metadata.isProduction, false);
});

test("metadata exposes only environment identity and never sensitive configuration", () => {
  const result = resolveEnvironmentMetadata(PRODUCTION_ENV);
  assert.ok(result.ok);

  assert.deepEqual(
    Object.keys(result.metadata).sort(),
    ["environment", "isProduction", "source", "version"],
  );

  const serialized = JSON.stringify(result);
  for (const sensitive of [
    PRODUCTION_PASSWORD,
    PRODUCTION_CRON_SECRET,
    PRODUCTION_URL,
    "postgresql",
    "DATABASE_URL",
    "databaseUrl",
    "CRON_SECRET",
    "cronSecret",
  ]) {
    assert.equal(
      serialized.includes(sensitive),
      false,
      `sensitive value leaked into metadata: ${sensitive}`,
    );
  }

  const failed = resolveEnvironmentMetadata({
    STELLARCORE_ENVIRONMENT: "production",
    DATABASE_URL: PRODUCTION_URL,
  });
  assert.deepEqual(failed, { ok: false, code: "ENVIRONMENT_METADATA_UNAVAILABLE" });
  assert.equal(JSON.stringify(failed).includes(PRODUCTION_PASSWORD), false);
});

test("metadata construction is deterministic for equivalent configurations", () => {
  const first = resolveEnvironmentMetadata(PREVIEW_ENV);
  const second = resolveEnvironmentMetadata({ ...PREVIEW_ENV });

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
