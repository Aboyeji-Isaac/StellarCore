import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  DATABASE_BUDGET_DEFAULTS,
  DatabaseBudgetConfigError,
  parseBudgetConfigFromEnv,
  validateBudgetConfig,
  type DatabaseBudgetInput,
} from "@/lib/db/budgetConfig";

// ---------------------------------------------------------------------------
// validateBudgetConfig — defaults
// ---------------------------------------------------------------------------

describe("validateBudgetConfig", () => {
  test("returns defaults when called with no input", () => {
    const result = validateBudgetConfig();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.config, DATABASE_BUDGET_DEFAULTS);
  });

  test("returns defaults when called with empty object", () => {
    const result = validateBudgetConfig({});
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.config, DATABASE_BUDGET_DEFAULTS);
  });

  test("accepts valid custom values", () => {
    const input: DatabaseBudgetInput = {
      poolMax: 10,
      acquisitionTimeoutMs: 3_000,
      idleTimeoutMs: 30_000,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 3_000,
      transactionTimeoutMs: 25_000,
    };
    const result = validateBudgetConfig(input);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepStrictEqual(result.config, input);
  });

  test("merges partial input with defaults", () => {
    const result = validateBudgetConfig({ poolMax: 3 });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.poolMax, 3);
    assert.equal(result.config.acquisitionTimeoutMs, DATABASE_BUDGET_DEFAULTS.acquisitionTimeoutMs);
  });

  // ---------------------------------------------------------------------------
  // Non-finite / negative / zero values
  // ---------------------------------------------------------------------------

  test("rejects NaN poolMax", () => {
    const result = validateBudgetConfig({ poolMax: NaN });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.field, "poolMax");
  });

  test("rejects Infinity acquisitionTimeoutMs", () => {
    const result = validateBudgetConfig({ acquisitionTimeoutMs: Infinity });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "acquisitionTimeoutMs");
  });

  test("rejects negative statementTimeoutMs", () => {
    const result = validateBudgetConfig({ statementTimeoutMs: -1 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "statementTimeoutMs");
  });

  test("rejects zero poolMax", () => {
    const result = validateBudgetConfig({ poolMax: 0 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "poolMax");
  });

  test("rejects zero lockTimeoutMs (unlimited not allowed)", () => {
    const result = validateBudgetConfig({ lockTimeoutMs: 0 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "lockTimeoutMs");
  });

  test("rejects negative Infinity", () => {
    const result = validateBudgetConfig({ idleTimeoutMs: -Infinity });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "idleTimeoutMs");
  });

  // ---------------------------------------------------------------------------
  // Non-integer poolMax
  // ---------------------------------------------------------------------------

  test("rejects fractional poolMax", () => {
    const result = validateBudgetConfig({ poolMax: 2.5 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "poolMax");
  });

  // ---------------------------------------------------------------------------
  // Range violations
  // ---------------------------------------------------------------------------

  test("rejects poolMax above maximum (100)", () => {
    const result = validateBudgetConfig({ poolMax: 101 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors[0]!.message, /\[1, 100\]/);
  });

  test("rejects acquisitionTimeoutMs below minimum (100ms)", () => {
    const result = validateBudgetConfig({ acquisitionTimeoutMs: 50 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors[0]!.message, /\[100, 60000\]/);
  });

  test("rejects transactionTimeoutMs above maximum (300000ms)", () => {
    const result = validateBudgetConfig({ transactionTimeoutMs: 400_000 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.errors[0]!.message, /\[1000, 300000\]/);
  });

  // ---------------------------------------------------------------------------
  // Timeout ordering violations
  // ---------------------------------------------------------------------------

  test("rejects lockTimeoutMs >= statementTimeoutMs", () => {
    const result = validateBudgetConfig({
      lockTimeoutMs: 15_000,
      statementTimeoutMs: 15_000,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "lockTimeoutMs");
    assert.match(result.errors[0]!.message, /strictly less than/);
  });

  test("rejects statementTimeoutMs >= transactionTimeoutMs", () => {
    const result = validateBudgetConfig({
      statementTimeoutMs: 20_000,
      transactionTimeoutMs: 20_000,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.errors[0]!.field, "statementTimeoutMs");
    assert.match(result.errors[0]!.message, /strictly less than/);
  });

  test("rejects lock > statement ordering", () => {
    const result = validateBudgetConfig({
      lockTimeoutMs: 30_000,
      statementTimeoutMs: 10_000,
    });
    assert.equal(result.ok, false);
  });

  // ---------------------------------------------------------------------------
  // Multiple errors
  // ---------------------------------------------------------------------------

  test("collects multiple field errors", () => {
    const result = validateBudgetConfig({
      poolMax: -1,
      acquisitionTimeoutMs: NaN,
      statementTimeoutMs: Infinity,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.length >= 3);
  });

  // ---------------------------------------------------------------------------
  // Valid edge cases
  // ---------------------------------------------------------------------------

  test("accepts minimum valid values", () => {
    const result = validateBudgetConfig({
      poolMax: 1,
      acquisitionTimeoutMs: 100,
      idleTimeoutMs: 1_000,
      lockTimeoutMs: 100,
      statementTimeoutMs: 500,
      transactionTimeoutMs: 1_000,
    });
    assert.equal(result.ok, true);
  });

  test("accepts maximum valid values", () => {
    const result = validateBudgetConfig({
      poolMax: 100,
      acquisitionTimeoutMs: 60_000,
      idleTimeoutMs: 600_000,
      lockTimeoutMs: 59_999,
      statementTimeoutMs: 120_000,
      transactionTimeoutMs: 300_000,
    });
    assert.equal(result.ok, true);
  });

  // ---------------------------------------------------------------------------
  // Frozen output
  // ---------------------------------------------------------------------------

  test("config is frozen", () => {
    const result = validateBudgetConfig();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.ok(Object.isFrozen(result.config));
  });
});

// ---------------------------------------------------------------------------
// parseBudgetConfigFromEnv
// ---------------------------------------------------------------------------

describe("parseBudgetConfigFromEnv", () => {
  test("returns defaults when no env vars are set", () => {
    const config = parseBudgetConfigFromEnv({ DATABASE_URL: "postgresql://user:pass@host:5432/db" });
    assert.deepStrictEqual(config, DATABASE_BUDGET_DEFAULTS);
  });

  test("parses valid env vars", () => {
    const config = parseBudgetConfigFromEnv({
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
      DB_POOL_MAX: "10",
      DB_POOL_ACQUISITION_TIMEOUT_MS: "3000",
    });
    assert.equal(config.poolMax, 10);
    assert.equal(config.acquisitionTimeoutMs, 3_000);
  });

  test("throws on non-numeric env var", () => {
    assert.throws(
      () => parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db",
        DB_POOL_MAX: "not-a-number",
      }),
      DatabaseBudgetConfigError,
    );
  });

  test("throws on empty string treated as unset (falls to default)", () => {
    const config = parseBudgetConfigFromEnv({
      DATABASE_URL: "postgresql://user:pass@host:5432/db",
      DB_POOL_MAX: "",
    });
    assert.equal(config.poolMax, DATABASE_BUDGET_DEFAULTS.poolMax);
  });

  test("throws on Infinity string", () => {
    assert.throws(
      () => parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db",
        DB_POOL_MAX: "Infinity",
      }),
      DatabaseBudgetConfigError,
    );
  });

  test("throws when DATABASE_URL contains statement_timeout param", () => {
    assert.throws(
      () => parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db?statement_timeout=30000",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseBudgetConfigError);
        assert.ok(error.errors.some((e) => e.message.includes("statement_timeout")));
        return true;
      },
    );
  });

  test("throws when DATABASE_URL contains lock_timeout param", () => {
    assert.throws(
      () => parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db?lock_timeout=5000",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseBudgetConfigError);
        assert.ok(error.errors.some((e) => e.message.includes("lock_timeout")));
        return true;
      },
    );
  });

  test("throws when DATABASE_URL contains idle_in_transaction_session_timeout param", () => {
    assert.throws(
      () => parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db?idle_in_transaction_session_timeout=10000",
      }),
      (error: unknown) => {
        assert.ok(error instanceof DatabaseBudgetConfigError);
        return true;
      },
    );
  });

  test("error message contains all invalid field details", () => {
    try {
      parseBudgetConfigFromEnv({
        DATABASE_URL: "postgresql://user:pass@host:5432/db",
        DB_POOL_MAX: "abc",
        DB_STATEMENT_TIMEOUT_MS: "xyz",
      });
      assert.fail("Expected DatabaseBudgetConfigError");
    } catch (error) {
      assert.ok(error instanceof DatabaseBudgetConfigError);
      assert.ok(error.errors.length >= 2);
      assert.match(error.message, /DB_POOL_MAX/);
      assert.match(error.message, /DB_STATEMENT_TIMEOUT_MS/);
    }
  });

  test("accepts no DATABASE_URL (URL validation is elsewhere)", () => {
    const config = parseBudgetConfigFromEnv({});
    assert.deepStrictEqual(config, DATABASE_BUDGET_DEFAULTS);
  });
});
