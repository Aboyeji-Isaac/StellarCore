/**
 * Postgres integration tests for evidence checkpoints.
 *
 * Conditionally skipped when TEST_DATABASE_URL is not set so the default
 * test runner remains green in environments without a Postgres instance.
 */

import test from "node:test";
import assert from "node:assert";
import { PrismaClient } from "../../../app/generated/prisma/client";
import { PrismaPadapterPg } from "@prisma/adapter-pg";
import {
  createCheckpoint,
  getLatestCheckpoint,
  EVIDENCE_CHECKPOINT_DAX,
} from "../../../lib/evidence/checkpoint";
import { verifyCheckpointChain } from "../../../lib/evidence/verification";
import type { CanonicalEvidenceEntry } from "../../../lib/evidence/canonicalization";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeIntegration = TEST_DATABASE_URL ? test : test.skip;

async function makePrisma(): Promise<PrismaClient> {
  const adapter = new PrismaAdapterPg({ connectionString: TEST_DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  await prisma.$executeRaw(Unsafe(EVIDENCE_CHECKPOINT_DAX));
  return prisma;
}

function Unsafe(sql: string) {
  return sql;
}

function makeEntry(
  id: string,
  overrides: Record<string, unknown> = {},
): CanonicalEvidenceEntry {
  return {
    kind: "rate_observation",
    id,
    fields: {
      id,
      anchorId: "anchor-1",
      corridorId: "corridor-1",
      rate: "1.234567890123456789",
      sourceAmount: "100",
      destinationAmount: "123.4567890123456789",
      fee: "0",
      capturedAt: new Date("2024-01-01T00:00:00.000Z"),
      ...overrides,
    },
  };
}

describeIntegration("evidence checkpoints (postgres)", () => {
  let prisma: PrismaClient;
  const chain = `test-${Date.now().toISOString()}-${Math.random().toString(36).slice(2)}`;

  test.before(async () => {
    prisma = await makePrisma();
  });

  test.after(async () => {
    await prisma.$executeRaw(
      Unsafe(`DELETE FROM evidence_checkpoints WHERE chain = '${chain}'`),
    );
    await prisma.$disconnect();
  });

  test("repeated checkpointing of identical evidence produces identical hashes", async () => {
    const entries = [makeEntry("a-1"), makeEntry("a-2")];
    const first = await createCheckpoint(prisma, chain, { entries });
    const second = await createCheckpoint(prisma, chain, { entries });
    assert.strictEqual(first.checkpoint.contentHash, second.checkpoint.contentHash);
    assert.strictEqual(first.checkpoint.chainHash, second.checkpoint.chainHash);
    assert.strictEqual(second.idempotent, true);
  });

  test("incremental checkpoints preserve chain/range continuity", async () => {
    const batch1 = [makeEntry("b-1"), makeEntry("b-2")];
    const batch2 = [makeEntry("b-3"), makeEntry("b-4")];
    const c1 = await createCheckpoint(prisma, chain, { entries: batch1 });
    const c2 = await createCheckpoint(prisma, chain, { entries: batch2 });
    assert.strictEqual(c2.checkpoint.previousCheckpointId, c1.checkpoint.id);
    assert.strictEqual(c2.checkpoint.previousCheckpointHash, c1.checkpoint.chainHash);
    const latest = await getLatestCheckpoint(prisma, chain);
    assert.strictEqual(latest?.id, c2.checkpoint.id);
  });

  test("verification detects modified, missing, and reordered evidence", async () => {
    const entries = [makeEntry("c-1"), makeEntry("c-2"), makeEntry("c-3")];
    await createCheckpoint(prisma, chain, { entries });

    const ok = await verifyCheckpointChain({
      prisma,
      chain,
      reader: async () => entries,
    });
    assert.strictEqual(ok.ok, true);

    const modified = [makeEntry("c-1"), makeEntry("c-2", { rate: "9.999" }), makeEntry("c-3")];
    const modifiedResult = await verifyCheckpointChain({
      prisma,
      chain,
      reader: async () => modified,
    });
    assert.strictEqual(modifiedResult.ok, false);
    assert.ok(
      modifiedResult.failures.some((f) => f.kind === "content_hash_mismatch"),
    );

    const missing = [makeEntry("c-1"), makeEntry("c-3")];
    const missingResult = await verifyCheckpointChain({
      prisma,
      chain,
      reader: async () => missing,
    });
    assert.strictEqual(missingResult.ok, false);
    assert.ok(
      missingResult.failures.some((f) => f.kind === "missing_evidence"),
    );

    const reordered = [makeEntry("c-2"), makeEntry("c-1"), makeEntry("c-3")];
    const reorderedResult = await verifyCheckpointChain({
      prisma,
      chain,
      reader: async () => reordered,
    });
    assert.strictEqual(reorderedResult.ok, false);
  });
});
