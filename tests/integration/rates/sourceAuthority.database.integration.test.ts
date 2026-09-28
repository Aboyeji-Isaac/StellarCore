import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { readLatestCorridorRate } from "@/lib/rates/latestRateReadModel";

/**
 * Opt-in PostgreSQL integration coverage for the persisted source-authority
 * provenance. Runs the real Prisma repository, the real schema constraints,
 * and the real read model against an isolated fixture database.
 */
const DATABASE_INTEGRATION_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("persisted authority provenance drives independent counting and legacy rows stay unknown", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const corridorSlug = `test-authority-corridor-${suffix}`;
  const anchorSlugs = [
    `test-authority-primary-${suffix}`,
    `test-authority-correlated-${suffix}`,
    `test-authority-secondary-${suffix}`,
    `test-authority-legacy-${suffix}`,
  ];
  const evaluatedAt = new Date();

  try {
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
    const anchors = await Promise.all(anchorSlugs.map((slug, index) =>
      db.anchor.create({
        data: {
          slug,
          name: `Authority Fixture ${index}`,
          homeDomain: `${suffix}-${index}.example.com`,
          tomlUrl: `https://${suffix}-${index}.example.com/.well-known/stellar.toml`,
          status: "LIVE",
        },
        select: { id: true },
      })));
    for (const anchor of anchors) {
      await db.anchorCorridor.create({
        data: { anchorId: anchor.id, corridorId: corridor.id },
      });
    }

    // Same authority, fresher primary; then a second reviewed authority; then a
    // legacy row migrated with no authority at all.
    await db.rateSnapshot.create({
      data: snapshot(corridor.id, anchors[0]!.id, "10", evaluatedAt, 2_000, "auth-0001", 1),
    });
    await db.rateSnapshot.create({
      data: snapshot(corridor.id, anchors[1]!.id, "99", evaluatedAt, 5_000, "auth-0001", 1),
    });
    await db.rateSnapshot.create({
      data: snapshot(corridor.id, anchors[2]!.id, "30", evaluatedAt, 1_000, "auth-0002", 4),
    });
    await db.rateSnapshot.create({
      data: snapshot(corridor.id, anchors[3]!.id, "1000", evaluatedAt, 500, null, null),
    });

    const result = await readLatestCorridorRate(corridorSlug, { evaluatedAt });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.totalObservationCount, 4);
    assert.equal(result.freshObservationCount, 4);
    assert.equal(result.independentAuthorityCount, 2);
    assert.equal(result.freshIndependentSourceCount, 2);
    // Only the independent values 10 and 30 may reach the median. Leaking the
    // correlated 99 or the legacy 1000 would change this result.
    assert.equal(result.median, "20");
    assert.equal(result.state, "healthy");
    // Ordered by anchor slug: correlated, legacy, primary, secondary.
    assert.deepEqual(
      result.observations.map(({ authorityId }) => authorityId),
      ["auth-0001", null, "auth-0001", "auth-0002"],
    );
    assert.deepEqual(
      result.exclusions
        .map(({ authorityId, exclusionReason }) => [authorityId, exclusionReason])
        .sort(),
      [
        [null, "unknown_authority"],
        ["auth-0001", "correlated_same_authority"],
      ],
    );
  } finally {
    await db.rateSnapshot.deleteMany({ where: { corridor: { slug: corridorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { corridor: { slug: corridorSlug } } });
    await db.anchor.deleteMany({ where: { slug: { in: anchorSlugs } } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});

test("schema constraints reject partial or malformed authority provenance", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const corridorSlug = `test-authority-check-corridor-${suffix}`;
  const anchorSlug = `test-authority-check-anchor-${suffix}`;

  try {
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
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Authority Check Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
      },
      select: { id: true },
    });

    await assert.rejects(
      db.rateSnapshot.create({
        data: snapshot(corridor.id, anchor.id, "1", new Date(), 1_000, "auth-0001", null),
      }),
      /authority_provenance_check/,
    );
    await assert.rejects(
      db.rateSnapshot.create({
        data: snapshot(corridor.id, anchor.id, "1", new Date(), 1_000, "zeam", 1),
      }),
      /authority_provenance_check/,
    );
    await assert.rejects(
      db.rateSnapshot.create({
        data: snapshot(corridor.id, anchor.id, "1", new Date(), 1_000, "auth-0001", 0),
      }),
      /authority_provenance_check/,
    );
  } finally {
    await db.rateSnapshot.deleteMany({ where: { corridor: { slug: corridorSlug } } });
    await db.anchorCorridor.deleteMany({ where: { corridor: { slug: corridorSlug } } });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});

function snapshot(
  corridorId: string,
  anchorId: string,
  rate: string,
  now: Date,
  ageMs: number,
  authorityId: string | null,
  authorityConfigurationVersion: number | null,
) {
  return {
    anchorId,
    corridorId,
    authorityId,
    authorityConfigurationVersion,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(now.getTime() - ageMs),
  };
}
