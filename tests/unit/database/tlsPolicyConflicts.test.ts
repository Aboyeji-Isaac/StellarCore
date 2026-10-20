import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  classifyUrlTlsParameters,
  resolveDatabaseTlsPolicy,
  stripTlsParameters,
  type ProductionTlsResolution,
  type TlsPolicyEnvironmentInput,
} from "@/lib/database/tlsPolicy";
import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";

/**
 * Conflicting database TLS settings (issue #452).
 *
 * Precedence rules under test (documented in docs/database-tls-policy.md):
 * 1. Within the URL, conflicting declarations (`sslmode` vs `ssl`, repeated
 *    `sslmode`) resolve to the weakest declared posture, independent of order.
 * 2. Any URL TLS declaration takes precedence over PGSSLMODE / PGSSL*.
 * 3. STELLARCORE_DB_CA wins over STELLARCORE_DB_CA_PATH, but a configured,
 *    unreadable CA path still fails production startup.
 * 4. The emergency gate only ever relaxes a URL that itself asks for a
 *    verification bypass; it never weakens a verified URL and never permits
 *    plaintext.
 *
 * All connection strings and certificates here are synthetic.
 */

const PASSWORD = "synthetic-password-452";
const HOST = "db.conflict.example.test";
const BASE_URL = `postgres://stellar:${PASSWORD}@${HOST}:5432/stellar`;
const FAKE_CA = "-----BEGIN CERTIFICATE-----\nSYNTHETIC-INLINE-CA-452\n-----END CERTIFICATE-----";

function withQuery(query: string): string {
  return `${BASE_URL}?${query}`;
}

function production(
  databaseUrl: string,
  overrides: Partial<TlsPolicyEnvironmentInput> = {},
): TlsPolicyEnvironmentInput {
  return {
    databaseUrl,
    isProductionLike: true,
    emergencyBypassRequested: false,
    inlineCa: null,
    caPath: null,
    caPathExists: false,
    ...overrides,
  };
}

function assertRejected(
  resolution: ProductionTlsResolution,
  code: string,
  parameter: string,
): void {
  assert.equal(resolution.accepted, false);
  if (resolution.accepted) return;
  assert.equal(resolution.rejection.code, code);
  assert.equal(resolution.rejection.signal?.parameter, parameter);
}

function assertVerified(resolution: ProductionTlsResolution): void {
  assert.equal(resolution.accepted, true);
  if (!resolution.accepted) return;
  assert.equal(resolution.mode, "VERIFY_FULL");
  assert.equal(resolution.sslConfig.rejectUnauthorized, true);
}

test("sslmode=require cannot mask ssl=no-verify in the same URL, in either order", () => {
  for (const query of ["sslmode=require&ssl=no-verify", "ssl=no-verify&sslmode=require"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(query))),
      "PRODUCTION_TLS_VERIFICATION_BYPASS",
      "ssl",
    );
  }
});

test("sslmode=verify-full cannot mask a plaintext ssl flag in the same URL", () => {
  for (const flag of ["0", "false"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(`sslmode=verify-full&ssl=${flag}`))),
      "PRODUCTION_TLS_DISABLED",
      "ssl",
    );
  }
});

test("a repeated sslmode resolves to the weakest value regardless of order", () => {
  for (const query of ["sslmode=verify-full&sslmode=disable", "sslmode=disable&sslmode=verify-full"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(query))),
      "PRODUCTION_TLS_DISABLED",
      "sslmode",
    );
  }

  for (const query of ["sslmode=verify-full&sslmode=prefer", "sslmode=prefer&sslmode=verify-full"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(query))),
      "PRODUCTION_TLS_VERIFICATION_BYPASS",
      "sslmode",
    );
  }
});

test("plaintext beats a verification bypass when both are declared", () => {
  assertRejected(
    resolveDatabaseTlsPolicy(production(withQuery("ssl=no-verify&sslmode=disable"), {
      emergencyBypassRequested: true,
    })),
    "PRODUCTION_TLS_DISABLED",
    "sslmode",
  );
});

test("agreeing TLS declarations stay accepted with verified TLS", () => {
  for (const query of [
    "sslmode=verify-full&ssl=true",
    "sslmode=require&ssl=1",
    "sslmode=verify-ca&sslmode=verify-full",
  ]) {
    assertVerified(resolveDatabaseTlsPolicy(production(withQuery(query))));
  }
});

test("sslmode values are normalized for case and surrounding whitespace", () => {
  for (const value of ["DISABLE", "Disable", "%20disable%20"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(`sslmode=${value}`))),
      "PRODUCTION_TLS_DISABLED",
      "sslmode",
    );
  }

  for (const value of ["NO-VERIFY", "%20Prefer"]) {
    assertRejected(
      resolveDatabaseTlsPolicy(production(withQuery(`sslmode=${value}`))),
      "PRODUCTION_TLS_VERIFICATION_BYPASS",
      "sslmode",
    );
  }

  assertVerified(resolveDatabaseTlsPolicy(production(withQuery("sslmode=Verify-Full"))));
});

test("an unrecognised sslmode never weakens production and never masks a weaker value", () => {
  assertVerified(resolveDatabaseTlsPolicy(production(withQuery("sslmode=strict-please"))));
  assertRejected(
    resolveDatabaseTlsPolicy(production(withQuery("sslmode=strict-please&sslmode=disable"))),
    "PRODUCTION_TLS_DISABLED",
    "sslmode",
  );
});

test("URL TLS declarations take precedence over PGSSLMODE in both directions", () => {
  const urlVerified = classifyUrlTlsParameters(withQuery("sslmode=verify-full"));
  assert.equal(urlVerified?.source, "URL_PARAMETER");

  assertVerified(resolveDatabaseTlsPolicy(
    production(withQuery("sslmode=verify-full")),
    { PGSSLMODE: "disable" },
  ));

  const urlDisabled = resolveDatabaseTlsPolicy(
    production(withQuery("sslmode=disable")),
    { PGSSLMODE: "verify-full" },
  );
  assertRejected(urlDisabled, "PRODUCTION_TLS_DISABLED", "sslmode");
  assert.ok(!urlDisabled.accepted && urlDisabled.rejection.signal?.source === "URL_PARAMETER");
});

test("PGSSLMODE decides only when the URL carries no TLS parameters", () => {
  const bypass = resolveDatabaseTlsPolicy(production(BASE_URL), { PGSSLMODE: "no-verify" });
  assertRejected(bypass, "PRODUCTION_TLS_VERIFICATION_BYPASS", "PGSSLMODE");
  assert.ok(!bypass.accepted && bypass.rejection.signal?.source === "PG_ENVIRONMENT");

  assertVerified(resolveDatabaseTlsPolicy(production(BASE_URL), { PGSSLMODE: "require" }));
  assertVerified(resolveDatabaseTlsPolicy(production(BASE_URL), { PGSSLROOTCERT: "/synthetic/ca.pem" }));
});

test("URL certificate parameters are stripped and never become the CA or relax verification", () => {
  const url = withQuery("sslmode=require&sslrootcert=%2Fsynthetic%2Fca.pem&sslcert=c.pem&sslkey=k.pem");
  const resolution = resolveDatabaseTlsPolicy(production(url));

  assertVerified(resolution);
  assert.ok(resolution.accepted && !("ca" in resolution.sslConfig));
  assert.equal(new URL(stripTlsParameters(url)).search, "");

  assertRejected(
    resolveDatabaseTlsPolicy(production(withQuery("sslrootcert=%2Fsynthetic%2Fca.pem&sslmode=disable"))),
    "PRODUCTION_TLS_DISABLED",
    "sslmode",
  );
});

test("the emergency gate does not weaken a verified URL", () => {
  for (const url of [BASE_URL, withQuery("sslmode=verify-full"), withQuery("sslmode=require")]) {
    assertVerified(resolveDatabaseTlsPolicy(production(url, { emergencyBypassRequested: true })));
  }
});

test("the emergency gate applies when any conflicting declaration asks for a bypass", () => {
  const resolution = resolveDatabaseTlsPolicy(production(withQuery("sslmode=verify-full&ssl=no-verify"), {
    emergencyBypassRequested: true,
    inlineCa: FAKE_CA,
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "NO_VERIFY");
  assert.deepEqual(resolution.accepted && { ...resolution.sslConfig }, { rejectUnauthorized: false });
});

test("development resolves conflicting declarations to the weakest posture too", () => {
  const resolution = resolveDatabaseTlsPolicy(production(withQuery("sslmode=verify-full&ssl=0"), {
    isProductionLike: false,
  }));

  assert.equal(resolution.accepted, true);
  assert.ok(resolution.accepted && resolution.mode === "DISABLED");
});

test("an inline CA takes precedence over a readable CA path", () => {
  const caDir = mkdtempSync(join(tmpdir(), "stellarcore-ca-conflict-"));
  const caPath = join(caDir, "provider-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nSYNTHETIC-FILE-CA-452\n-----END CERTIFICATE-----\n");

  try {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: withQuery("sslmode=require"),
      environmentId: "production",
      environment: { STELLARCORE_DB_CA: FAKE_CA, STELLARCORE_DB_CA_PATH: caPath },
    });

    assertVerified(result.resolution);
    assert.ok(result.resolution.accepted && result.resolution.mode === "VERIFY_FULL");
    assert.equal(result.resolution.sslConfig.ca, FAKE_CA);
  } finally {
    rmSync(caDir, { recursive: true, force: true });
  }
});

test("an unreadable CA path fails production startup even when an inline CA is set", () => {
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: BASE_URL,
    environmentId: "production",
    environment: {
      STELLARCORE_DB_CA: FAKE_CA,
      STELLARCORE_DB_CA_PATH: "/synthetic/missing/provider-ca.pem",
    },
  });

  assert.equal(result.resolution.accepted, false);
  assert.ok(!result.resolution.accepted && result.resolution.rejection.code === "PRODUCTION_TLS_CA_MISSING");
  assert.equal(JSON.stringify(result.resolution).includes("SYNTHETIC-INLINE-CA-452"), false);
});

test("a whitespace-only inline CA does not displace a readable CA path", () => {
  const caDir = mkdtempSync(join(tmpdir(), "stellarcore-ca-conflict-"));
  const caPath = join(caDir, "provider-ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nSYNTHETIC-FILE-CA-452\n-----END CERTIFICATE-----\n");

  try {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: BASE_URL,
      environmentId: "production",
      environment: { STELLARCORE_DB_CA: "   ", STELLARCORE_DB_CA_PATH: caPath },
    });

    assertVerified(result.resolution);
    assert.ok(result.resolution.accepted && result.resolution.mode === "VERIFY_FULL");
    assert.ok(result.resolution.sslConfig.ca?.includes("SYNTHETIC-FILE-CA-452"));
  } finally {
    rmSync(caDir, { recursive: true, force: true });
  }
});

test("the emergency gate is inert outside production", () => {
  for (const environmentId of ["development", "preview", "test"] as const) {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: withQuery("ssl=no-verify"),
      environmentId,
      environment: { STELLARCORE_DB_TLS_EMERGENCY_BYPASS: "allow-unverified" },
    });

    assert.equal(result.emergencyBypassActive, false, environmentId);
  }
});

test("an armed emergency gate with a verified URL keeps verification on in the runtime result", () => {
  const result = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: withQuery("sslmode=verify-full"),
    environmentId: "production",
    environment: { STELLARCORE_DB_TLS_EMERGENCY_BYPASS: "allow-unverified" },
  });

  assertVerified(result.resolution);
  assert.equal(result.sanitizedConnectionString.includes("sslmode"), false);
});

test("conflict diagnostics never expose credentials, hosts, or certificate material", () => {
  const conflicting = [
    "sslmode=require&ssl=no-verify",
    "sslmode=verify-full&ssl=0",
    "sslmode=verify-full&sslmode=disable",
    "sslrootcert=%2Fsynthetic%2Fca.pem&sslmode=prefer",
  ];

  for (const query of conflicting) {
    const result = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl: withQuery(query),
      environmentId: "production",
      environment: { STELLARCORE_DB_CA: FAKE_CA, PGSSLMODE: "verify-full" },
    });

    assert.equal(result.resolution.accepted, false, query);
    if (result.resolution.accepted) continue;

    const { message } = result.resolution.rejection;
    const serialized = JSON.stringify(result.resolution.rejection);
    for (const secret of [PASSWORD, HOST, "SYNTHETIC-INLINE-CA-452", "/synthetic/ca.pem"]) {
      assert.equal(serialized.includes(secret), false, `${query} leaked ${secret}`);
      assert.equal(message.includes(secret), false, `${query} leaked ${secret}`);
    }
  }
});
