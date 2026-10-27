import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyUrlTlsParameters,
  resolveDatabaseTlsPolicy,
  stripTlsParameters,
  type TlsPolicyEnvironmentInput,
} from "@/lib/database/tlsPolicy";
import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";

const VERIFIED_URL = "postgres://user:secret@db.example.com:5432/stellar";

function productionInput(overrides: Partial<TlsPolicyEnvironmentInput> = {}): TlsPolicyEnvironmentInput {
  return {
    databaseUrl: VERIFIED_URL,
    isProductionLike: true,
    emergencyBypassRequested: false,
    inlineCa: null,
    caPath: null,
    caPathExists: false,
    ...overrides,
  };
}

test("sanitized connection string preserves safe host and database details", () => {
  const urls = [
    "postgres://user:pass@db.example.com:5432/stellar",
    "postgresql://admin:pwd@localhost:5432/mydb",
    "postgres://user:pass@db.example.com:5432/stellar?sslmode=require",
  ];

  for (const url of urls) {
    const stripped = stripTlsParameters(url);
    const parsed = new URL(stripped);

    assert.ok(parsed.hostname, "hostname should be preserved");
    assert.ok(parsed.pathname, "database name should be preserved");
    if (url.includes("/stellar")) {
      assert.equal(parsed.pathname, "/stellar", "database name should match");
    }
  }
});

test("sanitized connection string preserves non-TLS query parameters", () => {
  const url = "postgres://user:pass@db.example.com:5432/stellar?connection_limit=5&application_name=stellarcore&sslmode=require";
  const stripped = stripTlsParameters(url);
  const parsed = new URL(stripped);

  assert.equal(parsed.searchParams.get("connection_limit"), "5");
  assert.equal(parsed.searchParams.get("application_name"), "stellarcore");
  assert.equal(parsed.searchParams.has("sslmode"), false);
});

test("policy rejection messages never embed credentials or host", () => {
  const secretUrl = "postgres://admin:super-secret-password@private-db.internal:5432/prod?sslmode=disable";
  const resolution = resolveDatabaseTlsPolicy(productionInput({ databaseUrl: secretUrl }));

  assert.equal(resolution.accepted, false);
  if (!resolution.accepted) {
    const serialized = JSON.stringify(resolution);
    assert.equal(serialized.includes("super-secret-password"), false);
    assert.equal(serialized.includes("private-db.internal"), false);
    assert.equal(serialized.includes("admin"), false);
  }
});

test("sanitized connection string strips all TLS parameters including sslrootcert, sslcert, sslkey", () => {
  const url = "postgres://user:pass@db.example.com:5432/stellar?sslrootcert=/etc/ssl/ca.pem&sslcert=/etc/ssl/client.pem&sslkey=/etc/ssl/client.key&sslmode=verify-full&connection_limit=10";
  const stripped = stripTlsParameters(url);
  const parsed = new URL(stripped);

  assert.equal(parsed.searchParams.has("sslrootcert"), false);
  assert.equal(parsed.searchParams.has("sslcert"), false);
  assert.equal(parsed.searchParams.has("sslkey"), false);
  assert.equal(parsed.searchParams.has("sslmode"), false);
  assert.equal(parsed.searchParams.get("connection_limit"), "10");
});

test("encoded credentials in URL are handled correctly in sanitized output", () => {
  const url = "postgres://user%40domain:pass%3Aword%23@db.example.com:5432/stellar?sslmode=require";
  const stripped = stripTlsParameters(url);
  const parsed = new URL(stripped);

  // URL parser preserves encoded form in username/password
  assert.equal(parsed.username, "user%40domain");
  assert.equal(parsed.password, "pass%3Aword%23");
  assert.equal(parsed.hostname, "db.example.com");
  assert.equal(parsed.searchParams.has("sslmode"), false);
});

test("multiple TLS query parameters are all stripped", () => {
  const url = "postgres://user:pass@db.example.com:5432/stellar?sslmode=require&ssl=no-verify&sslrootcert=ca.pem&sslcert=cert.pem&sslkey=key.pem&sslnegotiation=1&uselibpqcompat=on";
  const stripped = stripTlsParameters(url);
  const parsed = new URL(stripped);

  for (const param of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslnegotiation", "uselibpqcompat"]) {
    assert.equal(parsed.searchParams.has(param), false, `parameter ${param} should be stripped`);
  }
});

test("malformed URL returns original input without throwing", () => {
  const malformedUrls = [
    "not-a-url",
    "postgres://user:pass@",
    "postgres://",
    "",
  ];

  for (const url of malformedUrls) {
    const stripped = stripTlsParameters(url);
    assert.equal(stripped, url, "malformed URL should return unchanged");
  }
});

test("TLS policy rejection signal does not contain credentials", () => {
  const resolutions = [
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://admin:secret123@db.internal:5432/stellar?sslmode=disable",
    })),
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://admin:secret123@db.internal:5432/stellar?ssl=no-verify",
    })),
    resolveDatabaseTlsPolicy(productionInput({
      databaseUrl: "postgres://admin:secret123@db.internal:5432/stellar",
      emergencyBypassRequested: true,
    })),
  ];

  for (const resolution of resolutions) {
    if (!resolution.accepted) {
      const signal = resolution.rejection.signal;
      if (signal) {
        assert.ok(!signal.parameter?.includes("secret"), "signal parameter should not contain secret");
      }
      const serialized = JSON.stringify(resolution.rejection);
      assert.equal(serialized.includes("secret123"), false);
      assert.equal(serialized.includes("db.internal"), false);
    }
  }
});

test("resolveDatabaseTlsPolicyForEnvironment sanitizedConnectionString strips TLS params in all scenarios", () => {
  const scenarios = [
    { name: "plain URL", url: VERIFIED_URL },
    { name: "with sslmode=require", url: `${VERIFIED_URL}?sslmode=require&application_name=stellarcore` },
    { name: "with ssl=no-verify", url: `${VERIFIED_URL}?ssl=no-verify&connection_limit=5` },
    { name: "with multiple TLS params", url: `${VERIFIED_URL}?sslmode=verify-ca&sslrootcert=ca.pem&sslcert=cert.pem&sslkey=key.pem&app=myapp` },
  ];

  for (const { name, url } of scenarios) {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: url,
      environmentId: "production",
      environment: { DATABASE_URL: url },
    });

    const parsed = new URL(result.sanitizedConnectionString);
    for (const param of ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslnegotiation", "uselibpqcompat"]) {
      assert.equal(parsed.searchParams.has(param), false, `${name}: ${param} should be stripped`);
    }
    if (url.includes("application_name=stellarcore")) {
      assert.equal(parsed.searchParams.get("application_name"), "stellarcore");
    }
    if (url.includes("connection_limit=5")) {
      assert.equal(parsed.searchParams.get("connection_limit"), "5");
    }
    if (url.includes("app=myapp")) {
      assert.equal(parsed.searchParams.get("app"), "myapp");
    }
  }
});

test("classifyUrlTlsParameters signal never exposes credentials", () => {
  const urls = [
    "postgres://user:secret@db.example.com:5432/stellar?sslmode=disable",
    "postgres://admin:pwd@localhost:5432/mydb?ssl=no-verify",
    "postgres://user%40domain:pass%23@db.example.com:5432/stellar?sslmode=require",
  ];

  for (const url of urls) {
    const signal = classifyUrlTlsParameters(url);
    assert.ok(signal);
    if (signal) {
      const serialized = JSON.stringify(signal);
      assert.equal(serialized.includes("secret"), false);
      assert.equal(serialized.includes("pwd"), false);
      assert.equal(serialized.includes("pass"), false);
    }
  }
});

test("sanitized connection string from TLS policy runtime preserves port and path", () => {
  const urls = [
    "postgres://user:pass@db.example.com:5432/stellar",
    "postgresql://admin:pwd@db.internal:5432/mydb?sslmode=require",
  ];

  for (const url of urls) {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: url,
      environmentId: "production",
      environment: { DATABASE_URL: url },
    });

    const parsed = new URL(result.sanitizedConnectionString);
    assert.ok(parsed.hostname, "hostname should be preserved");
    assert.ok(parsed.pathname, "database path should be preserved");
    if (url.includes("5432")) {
      assert.equal(parsed.port, "5432", "port should be preserved");
    }
  }
});

test("sanitized output for valid rejection does not echo original secret-bearing URL", () => {
  const secretUrl = "postgresql://admin:prod-secret-token@prod-db.internal:5432/stellar?sslmode=disable&connection_limit=20";
  const resolution = resolveDatabaseTlsPolicy(productionInput({ databaseUrl: secretUrl }));

  assert.equal(resolution.accepted, false);
  if (!resolution.accepted) {
    const rejectionString = JSON.stringify(resolution.rejection);
    assert.equal(rejectionString.includes("prod-secret-token"), false);
    assert.equal(rejectionString.includes("prod-db.internal"), false);
    assert.equal(rejectionString.includes("admin"), false);
    assert.ok(rejectionString.includes("PRODUCTION_TLS_DISABLED"));
    assert.ok(rejectionString.includes("sslmode"));
  }
});

test("sanitized connection string retains query parameter order deterministically", () => {
  const url = "postgres://user:pass@db.example.com:5432/stellar?a=1&sslmode=require&b=2&sslrootcert=ca.pem&c=3";
  const stripped = stripTlsParameters(url);

  const parsed = new URL(stripped);
  const params = Array.from(parsed.searchParams.keys());
  assert.deepEqual(params, ["a", "b", "c"]);
});

test("runtime policy result sanitizedConnectionString never contains TLS parameters", () => {
  const testUrls = [
    "postgres://user:pass@db.example.com:5432/stellar?sslmode=require",
    "postgres://user:pass@db.example.com:5432/stellar?ssl=no-verify",
    "postgres://user:pass@db.example.com:5432/stellar?sslmode=verify-ca&sslrootcert=ca.pem",
  ];

  for (const url of testUrls) {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: url,
      environmentId: "production",
      environment: { DATABASE_URL: url },
    });

    assert.equal(result.sanitizedConnectionString.includes("sslmode="), false);
    assert.equal(result.sanitizedConnectionString.includes("ssl="), false);
    assert.equal(result.sanitizedConnectionString.includes("sslrootcert="), false);
    assert.equal(result.sanitizedConnectionString.includes("sslcert="), false);
    assert.equal(result.sanitizedConnectionString.includes("sslkey="), false);
  }
});