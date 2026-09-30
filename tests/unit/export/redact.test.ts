import assert from "node:assert/strict";
import test from "node:test";

import { isSecretKey, isSecretValue, redactValue, sanitizeForExport, assertNoSecrets } from "@/lib/export/redact";

test("isSecretKey detects password-like keys", () => {
  assert.ok(isSecretKey("password"));
  assert.ok(isSecretKey("PASSWORD"));
  assert.ok(isSecretKey("db_password"));
  assert.ok(isSecretKey("api_key"));
  assert.ok(isSecretKey("secret_token"));
  assert.ok(isSecretKey("accessToken"));
  assert.ok(isSecretKey("refresh_token"));
  assert.ok(isSecretKey("client_secret"));
  assert.ok(isSecretKey("database_url"));
  assert.ok(isSecretKey("connection_string"));
  assert.ok(isSecretKey("jwt_secret"));
  assert.ok(isSecretKey("private_key"));
  assert.ok(isSecretKey("encryption_key"));
});

test("isSecretKey does not flag normal keys", () => {
  assert.ok(!isSecretKey("name"));
  assert.ok(!isSecretKey("slug"));
  assert.ok(!isSecretKey("homeDomain"));
  assert.ok(!isSecretKey("status"));
  assert.ok(!isSecretKey("seps"));
  assert.ok(!isSecretKey("corridorCount"));
  assert.ok(!isSecretKey("rate"));
  assert.ok(!isSecretKey("capturedAt"));
});

test("isSecretValue detects long base64-like strings", () => {
  assert.ok(isSecretValue("a".repeat(44) + "=="));
  assert.ok(isSecretValue("A".repeat(43) + "="));
  assert.ok(isSecretValue("testsklivetesttesttesttesttesttesttesttesttesttest"));
  assert.ok(isSecretValue("testpktesttesttesttesttesttesttesttesttesttesttest"));
  assert.ok(isSecretValue("testrktesttesttesttesttesttesttesttesttesttesttest"));
});

test("isSecretValue detects JWT tokens", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  assert.ok(isSecretValue(jwt));
});

test("isSecretValue detects hex strings", () => {
  assert.ok(isSecretValue("a".repeat(64)));
  assert.ok(isSecretValue("A".repeat(32)));
});

test("isSecretValue detects database URLs", () => {
  assert.ok(isSecretValue("postgresql://user:pass@localhost:5432/db"));
  assert.ok(isSecretValue("postgres://user:pass@localhost:5432/db"));
  assert.ok(isSecretValue("mysql://user:pass@localhost:3306/db"));
  assert.ok(isSecretValue("redis://:pass@localhost:6379"));
  assert.ok(isSecretValue("mongodb://user:pass@localhost:27017/db"));
});

test("isSecretValue does not flag normal strings", () => {
  assert.ok(!isSecretValue("hello world"));
  assert.ok(!isSecretValue("MoneyGram"));
  assert.ok(!isSecretValue("mgxanchor.moneygram.com"));
  assert.ok(!isSecretValue("usdc-us-usd-us"));
  assert.ok(!isSecretValue("LIVE"));
  assert.ok(!isSecretValue("2026-01-15T12:00:00.000Z"));
  assert.ok(!isSecretValue("1.0"));
  assert.ok(!isSecretValue("short"));
  assert.ok(!isSecretValue("a".repeat(15)));
});

test("redactValue redacts secret keys", () => {
  const result = redactValue("config", { api_key: "secret123", name: "test" });
  assert.deepEqual(result, { api_key: "[REDACTED]", name: "test" });
});

test("redactValue redacts secret values", () => {
  const result = redactValue("config", { token: "testsklivetesttesttesttesttesttesttesttesttesttest" });
  assert.deepEqual(result, { token: "[REDACTED]" });
});

test("redactValue handles nested objects", () => {
  const result = redactValue("config", {
    database: { url: "postgresql://user:pass@localhost/db" },
    name: "test",
  });
  assert.deepEqual(result, {
    database: { url: "[REDACTED]" },
    name: "test",
  });
});

test("redactValue handles arrays", () => {
  const result = redactValue("config", {
    keys: ["testsklivetesttesttesttesttesttesttesttesttesttest", "normal"],
  });
  assert.deepEqual(result, { keys: ["[REDACTED]", "normal"] });
});

test("redactValue preserves non-secret data", () => {
  const result = redactValue("config", {
    slug: "moneygram",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
    seps: [1, 6, 10, 24, 31, 38],
    rate: "1.0",
    capturedAt: "2026-01-15T12:00:00.000Z",
  });
  assert.deepEqual(result, {
    slug: "moneygram",
    name: "MoneyGram",
    homeDomain: "mgxanchor.moneygram.com",
    seps: [1, 6, 10, 24, 31, 38],
    rate: "1.0",
    capturedAt: "2026-01-15T12:00:00.000Z",
  });
});

test("sanitizeForExport redacts secrets in full object", () => {
  const input = {
    anchor: { slug: "moneygram", api_key: "secret" },
    database_url: "postgresql://user:pass@localhost/db",
    normal: "data",
  };
  const result = sanitizeForExport(input);
  assert.deepEqual(result, {
    anchor: { slug: "moneygram", api_key: "[REDACTED]" },
    database_url: "[REDACTED]",
    normal: "data",
  });
});

test("assertNoSecrets passes for clean data", () => {
  assert.doesNotThrow(() => {
    assertNoSecrets({
      slug: "moneygram",
      name: "MoneyGram",
      rate: "1.0",
    });
  });
});

test("assertNoSecrets throws for secret keys", () => {
  assert.throws(() => {
    assertNoSecrets({ password: "secret" });
  }, /Secret key detected/);
});

test("assertNoSecrets throws for secret values", () => {
  assert.throws(() => {
    assertNoSecrets({ myToken: "testsklivetesttesttesttesttesttesttesttesttesttest" });
  }, /Potential secret detected/);
});

test("assertNoSecrets throws for nested secrets", () => {
  assert.throws(() => {
    assertNoSecrets({ config: { myDatabaseUrl: "postgresql://user:pass@localhost/db" } });
  }, /Potential secret detected/);
});