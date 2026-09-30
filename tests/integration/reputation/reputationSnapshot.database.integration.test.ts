import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PRISMA_REPUTATION_REPOSITORY } from "@/lib/reputation/repository";
import type { ReputationEvidenceSet } from "@/types/reputation";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";

/**
 * Issue #135: one evaluation must read its complete evidence set from ONE
 * PostgreSQL RepeatableRead snapshot. A concurrent writer commits rate and
 * outcome rows between the repository's internal query steps; if any read
 * escaped the snapshot, the observed set would be torn and the assertions on
 * pair-consistent evidence would fail. Additional concurrent evaluations must
 * each observe one coherent state without serialization anomalies.
 */
test("concurrent evidence writes cannot produce a torn reputation snapshot", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-rep-snap-${suffix}`;
  const corridorSlug = `test-rep-snap-corridor-${suffix}`;
  const now = new Date();
  // capturedAt timestamps deterministically encode the writer batch so the
  // test can tell which batch a snapshot's latest observation belongs to.
  const batchBase = now.getTime();
  const batchCapturedAt = (batch: number) => new Date(batchBase + batch * 1_000);

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Reputation Snapshot Integration Fixture",
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

    // Concurrent writer: commits new rate + outcome rows between the
    // repository's internal reads while evaluations run repeatedly.
    const writerStop = new Set<Promise<unknown>>();
    let writerCommitted = 0;
    const writer = (async () => {
      for (let batch = 1; batch <= 12; batch += 1) {
        await db.rateSnapshot.create({
          data: {
            anchorId: anchor.id,
            corridorId: corridor.id,
            rate: String(batch),
            sourceAmount: "1",
            destinationAmount: String(batch),
            fee: "0",
            capturedAt: batchCapturedAt(batch),
          },
        });
        await db.transferOutcome.create({
          data: {
            anchorId: anchor.id,
            corridorId: corridor.id,
            status: "COMPLETED",
            fillRate: 1,
            settlementMs: 1_000,
            slippage: 0,
          },
        });
        writerCommitted = batch;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
    writerStop.add(writer);

    const evaluations = await Promise.all(
      Array.from({ length: 4 }, () =>
        PRISMA_REPUTATION_REPOSITORY.readEvidence(
          anchorSlug,
          new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000),
        )),
    );
    await Promise.all(writerStop);
    assert.equal(writerCommitted, 12);

    for (const result of evaluations) {
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      const { evidence, snapshot }: ReputationEvidenceSet = result.evidenceSet;

      // Snapshot context is typed and bounded (for #134 manifest integration).
      assert.equal(snapshot.isolationLevel, "RepeatableRead");
      assert.equal(snapshot.readOnly, true);
      // pg_current_snapshot() format: xmin:xmax:xip-list.
      assert.match(snapshot.transactionId, /^\d+:\d+:/);
      assert.equal(Number.isFinite(Date.parse(snapshot.snapshotAt)), true);

      // Structure: DISTINCT ON yields at most one latest observation per
      // member corridor.
      assert.ok(
        evidence.latestRates.length <= evidence.corridorSlugs.length,
        "latest-per-corridor invariant violated",
      );

      // Torn-read detector: the writer commits rate batch N strictly before
      // outcome batch N, and the latest rate's destination_amount encodes its
      // batch. Any coherent snapshot must observe no more outcomes than the
      // batch number of its latest observed rate. A statement-by-statement
      // (non-snapshot) reader can observe outcomes from a later batch than
      // its rate observation and would violate this bound.
      for (const rate of evidence.latestRates) {
        const latestBatch = batchOf(rate);
        assert.ok(
          Number.isFinite(latestBatch) && latestBatch >= 1,
          `latest rate must identify a committed batch, got ${latestBatch}`,
        );
        assert.ok(
          evidence.transferOutcomes.length <= latestBatch,
          `torn snapshot: ${evidence.transferOutcomes.length} outcomes exceed latest rate batch ${latestBatch}`,
        );
      }

      // Every observed outcome matches the deterministic writer sequence.
      for (const outcome of evidence.transferOutcomes) {
        assert.equal(outcome.status, "COMPLETED");
        assert.equal(outcome.settlementMs, 1_000);
        assert.equal(outcome.slippage, 0);
      }

      // Deterministic ordering is preserved across evaluations.
      const slugs = evidence.corridorSlugs;
      assert.deepEqual(slugs, [...slugs].sort((left, right) => left.localeCompare(right)));
    }

    // The final evaluation sees the settled state.
    const settled = await PRISMA_REPUTATION_REPOSITORY.readEvidence(
      anchorSlug,
      new Date(now.getTime() - 90 * 24 * 60 * 60 * 1_000),
    );
    assert.equal(settled.ok, true);
    if (settled.ok) {
      assert.equal(settled.evidenceSet.evidence.transferOutcomes.length, 12);
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

  function batchOf(rate: { capturedAt: Date | string }): number {
    const time = rate.capturedAt instanceof Date
      ? rate.capturedAt.getTime()
      : Date.parse(rate.capturedAt);
    return Math.round((time - batchBase) / 1_000);
  }
});

/**
 * Two sequential evaluations must receive distinct snapshot identities so a
 * manifest (#134) can tell which database observation produced each result.
 */
test("sequential evaluations observe distinct transaction snapshot identities", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-rep-snap-id-${suffix}`;

  try {
    await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Snapshot Identity Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
    });

    const first = await PRISMA_REPUTATION_REPOSITORY.readEvidence(
      anchorSlug,
      new Date(),
    );
    const second = await PRISMA_REPUTATION_REPOSITORY.readEvidence(
      anchorSlug,
      new Date(),
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.notEqual(
        first.evidenceSet.snapshot.snapshotAt,
        second.evidenceSet.snapshot.snapshotAt,
      );
    }
  } finally {
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.$disconnect();
  }
});
