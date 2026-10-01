import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { resolveDatabaseTlsPolicyForEnvironment } from "@/lib/database/tlsPolicyRuntime";

/**
 * Live TLS-capable PostgreSQL integration (issue #181).
 *
 * Skipped unless RUN_DATABASE_TLS_INTEGRATION=1 and a TLS-enabled PostgreSQL
 * endpoint is supplied. The default StellarCore run never executes this test;
 * see docs/database-tls-policy.md for the manual procedure.
 *
 * Required environment when enabled:
 * - DATABASE_TLS_URL: postgres://... URL of a TLS-enabled PostgreSQL server
 *   (e.g. a Supabase/Vercel Postgres endpoint or local Postgres with ssl=on).
 * - Optionally DATABASE_TLS_CA: PEM of the server's CA when it does not
 *   chain to public roots.
 *
 * The test asserts: policy accepts a verified-TLS configuration, and a real
 * connection over the verified transport executes a trivial query.
 */
const TLS_INTEGRATION_ENABLED = process.env.RUN_DATABASE_TLS_INTEGRATION === "1";

test("verified-TLS PostgreSQL configuration connects and executes over the authenticated transport", {
  skip: !TLS_INTEGRATION_ENABLED,
}, async () => {
  const databaseUrl = process.env.DATABASE_TLS_URL;
  assert.ok(databaseUrl, "DATABASE_TLS_URL must be provided when RUN_DATABASE_TLS_INTEGRATION=1");

  const inlineCa = process.env.DATABASE_TLS_CA ?? null;
  let caPath: string | null = null;

  if (inlineCa) {
    const caDir = mkdtempSync(join(tmpdir(), `stellarcore-tls-${randomUUID().slice(0, 8)}-`));
    caPath = join(caDir, "ca.pem");
    writeFileSync(caPath, inlineCa, "utf8");
    process.env.STELLARCORE_DB_CA_PATH = caPath;
  } else {
    process.env.STELLARCORE_DB_CA = process.env.DATABASE_TLS_CA ?? "";
    delete process.env.STELLARCORE_DB_CA;
  }

  try {
    const tls = resolveDatabaseTlsPolicyForEnvironment({
      databaseUrl,
      environment: {
        NODE_ENV: "production",
        ...(inlineCa ? {} : {}),
      },
    });

    assert.equal(tls.resolution.accepted, true);
    if (!tls.resolution.accepted) return;
    assert.equal(tls.resolution.mode, "VERIFY_FULL");

    // Import the real driver only inside the gated test.
    const pg = await import("pg");
    const pool = new pg.Pool({
      connectionString: tls.sanitizedConnectionString,
      ssl: {
        ...tls.resolution.sslConfig,
        ...(inlineCa ? { ca: inlineCa } : {}),
      },
      connectionTimeoutMillis: 10_000,
    });

    try {
      const result = await pool.query("SELECT current_setting('ssl') AS ssl_enabled, version()");
      assert.ok(result.rows.length === 1);
      // The connection succeeded over the authenticated transport; ssl is on
      // for the session.
      assert.equal(result.rows[0]?.ssl_enabled, "on");
    } finally {
      await pool.end();
    }
  } finally {
    if (caPath) {
      delete process.env.STELLARCORE_DB_CA_PATH;
      rmSync(caPath, { force: true });
    }
  }
});

test("policy rejects a plaintext-forcing URL before any driver connection is attempted", {
  skip: !TLS_INTEGRATION_ENABLED,
}, async () => {
  const plaintextUrl = (process.env.DATABASE_TLS_URL ?? "postgres://user:secret@localhost:5432/db")
    .replace(/([?&])sslmode=[^&]*/, "$1")
    .concat("&sslmode=disable");

  const tls = resolveDatabaseTlsPolicyForEnvironment({
    databaseUrl: plaintextUrl,
    environment: { NODE_ENV: "production" },
  });

  assert.equal(tls.resolution.accepted, false);
  if (!tls.resolution.accepted) {
    assert.equal(tls.resolution.rejection.code, "PRODUCTION_TLS_DISABLED");
  }

  // The policy rejection happens before any driver involvement, so no
  // connection is possible: prove the sanitized URL no longer disables TLS.
  assert.equal(tls.sanitizedConnectionString.includes("sslmode=disable"), false);
});
