import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { evaluateAnchorReputation } from "@/lib/reputation/engine";
import { calculateReputation } from "@/lib/reputation/score";
import {
  PRISMA_REPUTATION_MANIFEST_REPOSITORY,
  PRISMA_REPUTATION_REPOSITORY,
} from "@/lib/reputation/repository";
import type { ReputationEvidence } from "@/types/reputation";

const DATABASE_INTEGRATION_ENABLED =
  process.env.RUN_REPUTATION_DATABASE_INTEGRATION === "1";
const DAYS_TO_MS = 24 * 60 * 60 * 1_000;

test("evidence-set manifests are atomic, referentially intact, and immutable", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-manifest-${suffix}`;
  const sparseAnchorSlug = `test-manifest-sparse-${suffix}`;
  const corridorASlug = `test-manifest-a-${suffix}`;
  const corridorBSlug = `test-manifest-b-${suffix}`;
  const evaluatedAt = new Date();

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Manifest Integration Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });
    const sparseAnchor = await db.anchor.create({
      data: {
        slug: sparseAnchorSlug,
        name: "Manifest Sparse Fixture",
        homeDomain: `sparse-${suffix}.example.com`,
        tomlUrl: `https://sparse-${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });
    const corridorA = await db.corridor.create({
      data: {
        slug: corridorASlug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "BRL",
        countryTo: "BR",
      },
      select: { id: true },
    });
    const corridorB = await db.corridor.create({
      data: {
        slug: corridorBSlug,
        assetCodeFrom: "USDC",
        countryFrom: "US",
        assetCodeTo: "ARS",
        countryTo: "AR",
      },
      select: { id: true },
    });
    await db.anchorCorridor.createMany({
      data: [
        { anchorId: anchor.id, corridorId: corridorA.id },
        { anchorId: anchor.id, corridorId: corridorB.id },
        { anchorId: sparseAnchor.id, corridorId: corridorA.id },
      ],
    });
    const freshSnapshot = await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridorA.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: evaluatedAt,
      },
      select: { id: true },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: anchor.id,
        corridorId: corridorB.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: new Date(evaluatedAt.getTime() - 120_001),
      },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: sparseAnchor.id,
        corridorId: corridorA.id,
        rate: "1",
        sourceAmount: "1",
        destinationAmount: "1",
        fee: "0",
        capturedAt: evaluatedAt,
      },
    });
    await db.transferOutcome.createMany({
      data: [
        ...Array.from({ length: 30 }, (_, index) => ({
          anchorId: anchor.id,
          corridorId: corridorA.id,
          status: "COMPLETED" as const,
          fillRate: 1,
          settlementMs: 1_000,
          slippage: 0,
          recordedAt: new Date(evaluatedAt.getTime() - (index + 1) * 1_000),
        })),
        {
          anchorId: anchor.id,
          corridorId: corridorA.id,
          status: "ERROR" as const,
          fillRate: 0,
          settlementMs: 1_000,
          slippage: 0,
          recordedAt: new Date(evaluatedAt.getTime() + 60_000),
        },
        {
          anchorId: anchor.id,
          corridorId: corridorA.id,
          status: "COMPLETED" as const,
          fillRate: 1,
          settlementMs: 1_000,
          slippage: 0,
          recordedAt: new Date(evaluatedAt.getTime() - 100 * DAYS_TO_MS),
        },
      ],
    });

    const first = await evaluateAnchorReputation(anchorSlug, { evaluatedAt });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(first.persisted?.manifestId);

    const manifest = await PRISMA_REPUTATION_MANIFEST_REPOSITORY.readManifest(
      first.persisted!.manifestId!,
    );
    assert.ok(manifest);
    if (!manifest) return;
    assert.equal(manifest.manifestSchemaVersion, 1);
    assert.equal(manifest.corridorCount, 2);
    assert.equal(manifest.latestRateCount, 2);
    assert.equal(manifest.freshRateCount, 1);
    assert.equal(manifest.outcomeCount, 30);
    assert.equal(manifest.completedOutcomeCount, 30);
    assert.equal(manifest.outsideOutcomeCount, 1);
    assert.equal(manifest.rateMembers.length, 2);
    assert.equal(manifest.outcomeMembers.length, 31);
    assert.equal(
      manifest.rateMembers.some((member) =>
        member.rateSnapshotId === freshSnapshot.id && member.eligibility === "ELIGIBLE"),
      true,
    );
    assert.equal(
      manifest.rateMembers.some((member) => member.reasonCode === "STALE_RATE"),
      true,
    );
    assert.equal(
      manifest.outcomeMembers.some((member) =>
        member.reasonCode === "FUTURE_TIMESTAMP" && member.eligibility === "EXCLUDED"),
      true,
    );

    const latest = await PRISMA_REPUTATION_MANIFEST_REPOSITORY
      .readLatestManifestForAnchor(anchorSlug);
    assert.equal(latest?.id, manifest.id);

    // Immutable membership: a second evaluation appends a new manifest and
    // leaves the first manifest byte-for-byte identical.
    const second = await evaluateAnchorReputation(anchorSlug, {
      evaluatedAt: new Date(evaluatedAt.getTime() + 1_000),
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      assert.notEqual(second.persisted?.manifestId, first.persisted?.manifestId);
    }
    const reRead = await PRISMA_REPUTATION_MANIFEST_REPOSITORY.readManifest(manifest.id);
    assert.deepEqual(reRead, manifest);
    assert.equal(
      await db.reputationEvidenceManifest.count({ where: { anchorId: anchor.id } }),
      2,
    );

    // The database rejects mutation of a persisted manifest and its members.
    await assert.rejects(
      db.$executeRawUnsafe(
        'UPDATE "reputation_evidence_manifests" SET "corridor_count" = 0 WHERE "id" = $1::uuid',
        manifest.id,
      ),
    );
    await assert.rejects(
      db.$executeRawUnsafe(
        'UPDATE "reputation_evidence_outcome_members" SET "ordinal" = 999 WHERE "manifest_id" = $1::uuid',
        manifest.id,
      ),
    );

    // Atomicity: a manifest that cannot be completed rolls the whole
    // evaluation back, so the score never becomes current with partial input.
    const beforeScore = await db.reputationScore.findUnique({
      where: { anchorId: anchor.id },
      select: { computedAt: true },
    });
    const brokenEvidence: ReputationEvidence = Object.freeze({
      anchorId: anchor.id,
      anchorSlug,
      status: "LIVE",
      corridors: Object.freeze([{ corridorId: corridorA.id, slug: corridorASlug }]),
      latestRates: Object.freeze([{
        rateSnapshotId: randomUUID(),
        corridorId: corridorA.id,
        corridorSlug: corridorASlug,
        capturedAt: evaluatedAt,
      }]),
      transferOutcomes: Object.freeze([]),
      outsideOutcomeCount: 0,
    });
    await assert.rejects(PRISMA_REPUTATION_REPOSITORY.upsertScore({
      anchorId: anchor.id,
      evaluatedAt,
      outcomeWindowStart: new Date(evaluatedAt.getTime() - 90 * DAYS_TO_MS),
      evidence: brokenEvidence,
      calculation: calculateReputation(brokenEvidence, evaluatedAt),
    }));
    const afterScore = await db.reputationScore.findUnique({
      where: { anchorId: anchor.id },
      select: { computedAt: true },
    });
    assert.equal(
      await db.reputationEvidenceManifest.count({ where: { anchorId: anchor.id } }),
      2,
    );
    assert.equal(afterScore?.computedAt.getTime(), beforeScore?.computedAt.getTime());

    // Truthful zero-outcome behavior: no synthetic outcomes are created.
    const sparse = await evaluateAnchorReputation(sparseAnchorSlug, { evaluatedAt });
    assert.equal(sparse.ok, true);
    if (sparse.ok) {
      assert.equal(sparse.calculation.state, "insufficient_evidence");
      const sparseManifest = await PRISMA_REPUTATION_MANIFEST_REPOSITORY.readManifest(
        sparse.persisted!.manifestId!,
      );
      assert.equal(sparseManifest?.outcomeCount, 0);
      assert.equal(sparseManifest?.completedOutcomeCount, 0);
      assert.deepEqual(sparseManifest?.outcomeMembers, []);
    }
  } finally {
    for (const slug of [anchorSlug, sparseAnchorSlug]) {
      await db.reputationEvidenceOutcomeMember.deleteMany({
        where: { manifest: { anchor: { slug } } },
      });
      await db.reputationEvidenceRateMember.deleteMany({
        where: { manifest: { anchor: { slug } } },
      });
      await db.reputationEvidenceCorridorMember.deleteMany({
        where: { manifest: { anchor: { slug } } },
      });
      await db.reputationEvidenceManifest.deleteMany({ where: { anchor: { slug } } });
      await db.reputationScore.deleteMany({ where: { anchor: { slug } } });
      await db.transferOutcome.deleteMany({ where: { anchor: { slug } } });
      await db.rateSnapshot.deleteMany({ where: { anchor: { slug } } });
      await db.anchorCorridor.deleteMany({ where: { anchor: { slug } } });
      await db.anchor.deleteMany({ where: { slug } });
    }
    await db.corridor.deleteMany({
      where: { slug: { in: [corridorASlug, corridorBSlug] } },
    });
    await db.$disconnect();
  }
});
