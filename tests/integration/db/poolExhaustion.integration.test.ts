import assert from "node:assert/strict";
import test from "node:test";

import { getRatesApiResult } from "@/lib/api/rates";
import type { StaleEvidenceStore } from "@/lib/api/staleEvidence";
import { createHardenedPool } from "@/lib/db/poolManager";
import { createMockPostgresServer } from "@/tests/integration/db/fixtures/mockPostgresServer";

const NOW = new Date("2026-09-20T12:00:00.000Z");
const CORRIDOR = "usdc-us-brl-br";
const NO_STALE_STORE: StaleEvidenceStore = {
  read: async () => null,
  write: async () => {},
};

test("a bounded exhausted pool returns a safe API error and recovers after capacity is released", async () => {
  const server = await createMockPostgresServer();
  const pool = createHardenedPool(server.connectionString, {
    max: 1,
    connectionTimeoutMillis: 75,
  });
  const held = await pool.connect();
  let heldReleased = false;
  let reported = 0;

  const request = () => getRatesApiResult(CORRIDOR, {
    now: () => NOW,
    staleEvidenceStore: NO_STALE_STORE,
    reportError: () => { reported++; },
    readLatestRate: async (slug) => {
      await pool.query("SELECT 1");
      return {
        ok: true,
        corridor: { slug, assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "BRL", countryTo: "BR" },
        evaluatedAt: NOW.toISOString(),
        state: "insufficient_fresh_sources",
        median: null,
        totalIndependentSources: 0,
        freshSourceCount: 0,
        observations: [],
        exclusions: [],
      } as const;
    },
  });

  try {
    const failed = await request();
    assert.deepEqual(failed, {
      status: 500,
      body: { error: { code: "internal_error", message: "Unable to read rates." } },
    });
    assert.equal(reported, 1);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount, 1);

    held.release();
    heldReleased = true;
    const recovered = await request();
    assert.equal(recovered.status, 200);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 1);

    server.setMode("DROP_ON_QUERY");
    await assert.rejects(pool.query("SELECT 1"));
    server.setMode("NORMAL");

    const afterFailedOperation = await request();
    assert.equal(afterFailedOperation.status, 200);
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.idleCount, 1);
    assert.ok(server.getActiveConnectionsCount() <= 1);
  } finally {
    if (!heldReleased) held.release();
    await pool.end();
    await server.close();
  }
});
