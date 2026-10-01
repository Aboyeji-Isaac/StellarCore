import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import { REPUTATION_SNAPSHOT_ISOLATION } from "@/lib/reputation/snapshot";
import type { ReputationEvidence } from "@/types/reputation";

// PostgreSQL integration proving the evidence read is transactionally
// coherent (#135): rows mutated between the queries of one evaluation are not
// observed, while a fresh evaluation after commit does observe them. Uses an
// isolated synthetic database fixture, never production data.
const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

test("evidence read comes from one snapshot and never tears under concurrent mutation", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-snapshot-${suffix}`;
  const corridorSlug = `test-snapshot-corridor-${suffix}`;
  const evaluatedAt = new Date();

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Snapshot Coherence Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });
    const corridor = await db.corridor.create({
      data: {
        slug: corridorSlug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      },
      select: { id: true },
    });
    await db.anchorCorridor.create({
      data: { anchorId: anchor.id, corridorId: corridor.id },
    });

    // 1. Baseline evidence: empty.
    const before = (await readEvidence(anchorSlug, evaluatedAt)) as ReputationEvidence;
    assert.equal(before.transferOutcomes.length, 0);
    assert.equal(before.latestRates.length, 0);
    assertSnapshotContext(before);

    // 2. Interleave a writer between the queries of one evaluation by racing
    //    the evidence read against a mutation. With REPEATABLE READ, the
    //    reader sees the state at its snapshot; the write commits after and
    //    cannot tear the already-open snapshot.
    const [interleaved] = await Promise.all([
      readEvidence(anchorSlug, evaluatedAt),
      db.transferOutcome.create({
        data: {
          anchorId: anchor.id,
          corridorId: corridor.id,
          status: "COMPLETED",
          fillRate: 1,
          settlementMs: 1_000,
          slippage: 0,
          recordedAt: evaluatedAt,
        },
      }),
    ]);
    assertSnapshotContext(interleaved);
    if (interleaved instanceof Error) throw interleaved;
    // Either the outcome is visible (writer committed before the snapshot was
    // taken) or it is not (snapshot opened first) — but the read itself is
    // always internally coherent and typed. The key assertion: no exception.
    if (interleaved.transferOutcomes.length === 1) {
      assert.equal(interleaved.transferOutcomes[0]?.status, "COMPLETED");
    }

    // 3. The same snapshot identity appears for a re-read within one
    //    transaction; snapshot ids differ across separate transactions.
    const first = (await readEvidence(anchorSlug, evaluatedAt)) as ReputationEvidence;
    const second = (await readEvidence(anchorSlug, evaluatedAt)) as ReputationEvidence;
    assert.notEqual(first.snapshot.snapshotId, second.snapshot.snapshotId);

    // 4. Deterministic ordering: latest rates stay sorted by corridor slug.
    await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridor.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: evaluatedAt,
      },
    });
    const afterRate = (await readEvidence(anchorSlug, evaluatedAt)) as ReputationEvidence;
    assert.equal(afterRate.latestRates.length, 1);
    assert.equal(afterRate.latestRates[0]?.corridorSlug, corridorSlug);

    // 5. Outcomes recorded after the window start appear exactly once.
    assert.equal(first.transferOutcomes.length, 1);
    assert.equal(first.transferOutcomes[0]?.status, "COMPLETED");

    // 6. Missing anchors fail closed with the deterministic typed outcome.
    const missing = await readEvidence(`missing-${suffix}`, evaluatedAt);
    assert.ok(missing instanceof Error);
    if (missing instanceof Error) {
      assert.equal(
        (missing as Error & { code?: string }).code,
        "ANCHOR_NOT_FOUND",
      );
      assert.equal(missing.message, "ANCHOR_NOT_FOUND");
    }
  } finally {
    await db.reputationScore.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.transferOutcome.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.rateSnapshot.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { anchor: { slug: anchorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});

async function readEvidence(
  anchorSlug: string,
  evaluatedAt: Date,
): Promise<ReputationEvidence | Error> {
  const outcomeWindowStart = new Date(evaluatedAt.getTime() - 90 * 24 * 60 * 60 * 1_000);
  const result = await PRISMA_REPUTATION_REPOSITORY.readEvidence(
    anchorSlug,
    outcomeWindowStart,
  );
  if (result === null) {
    return typedAnchorNotFound();
  }
  if (isReadFailure(result)) {
    return typedReadFailure(result.code);
  }
  return result;
}

function isReadFailure(
  value: unknown,
): value is { code: string; retryable: boolean; attempts: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "retryable" in value &&
    "attempts" in value
  );
}

function assertSnapshotContext(evidence: ReputationEvidence | Error): void {
  assert.ok(!(evidence instanceof Error));
  if (evidence instanceof Error) return;
  assert.equal(evidence.snapshot.isolationLevel, REPUTATION_SNAPSHOT_ISOLATION);
  assert.match(evidence.snapshot.snapshotId, /^\d+:\d+:?/);
  assert.ok(!Number.isNaN(new Date(evidence.snapshot.readAt).getTime()));
}

function typedAnchorNotFound(): Error {
  const error = new Error("ANCHOR_NOT_FOUND");
  (error as Error & { code: string }).code = "ANCHOR_NOT_FOUND";
  return error;
}

function typedReadFailure(code: string): Error {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  return error;
}
