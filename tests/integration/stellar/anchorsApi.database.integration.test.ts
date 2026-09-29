import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { getAnchorApiResult, getAnchorsApiResult } from "@/lib/api/anchors";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("persisted anchors and AnchorCorridor relations are read from the database in isolation", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-anchor-api-${suffix}`;
  const corridorSlug = `test-corridor-api-${suffix}`;
  const registryOnlySlug = `test-registry-only-${suffix}`;
  const retiredAnchorSlug = `test-retired-anchor-${suffix}`;
  const retiredCorridorSlug = `test-retired-corridor-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Anchor API Integration Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "DEGRADED",
        seps: [38, 1, 24],
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
    const retiredAnchor = await db.anchor.create({
      data: {
        slug: retiredAnchorSlug,
        name: "Retired historical fixture",
        homeDomain: `retired-${suffix}.example.com`,
        tomlUrl: `https://retired-${suffix}.example.com/.well-known/stellar.toml`,
        registryActive: false,
        registryRetiredAt: new Date(),
        registryRetirementReason: "removed_from_reviewed_registry",
      },
      select: { id: true },
    });
    const retiredCorridor = await db.corridor.create({
      data: {
        slug: retiredCorridorSlug,
        assetCodeFrom: "USD",
        countryFrom: "US",
        assetCodeTo: "NGN",
        countryTo: "NG",
        registryActive: false,
        registryRetiredAt: new Date(),
        registryRetirementReason: "removed_from_reviewed_registry",
      },
      select: { id: true },
    });
    await db.rateSnapshot.create({
      data: {
        anchorId: retiredAnchor.id,
        corridorId: retiredCorridor.id,
        rate: "1500",
        sourceAmount: "1",
        destinationAmount: "1500",
      },
    });

    const list = await getAnchorsApiResult();
    const detail = await getAnchorApiResult(anchorSlug);
    const registryOnly = await getAnchorApiResult(registryOnlySlug);
    const retired = await getAnchorApiResult(retiredAnchorSlug);

    assert.equal(list.status, 200);
    assert.equal(detail.status, 200);
    assert.equal(registryOnly.status, 404);
    assert.equal(retired.status, 404);
    assert.equal(await db.rateSnapshot.count({
      where: { anchorId: retiredAnchor.id, corridorId: retiredCorridor.id },
    }), 1);
    if (list.status !== 200 || detail.status !== 200) return;
    const listed = list.body.anchors.find(({ slug }) => slug === anchorSlug);
    assert.equal(listed?.corridorCount, 1);
    assert.deepEqual(listed?.seps, [1, 24, 38]);
    assert.equal(listed?.isTransferCapable, true);
    assert.equal(detail.body.anchor.status, "DEGRADED");
    assert.equal(detail.body.anchor.isTransferCapable, true);
    assert.deepEqual(detail.body.anchor.corridors, [{
      slug: corridorSlug,
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }]);
  } finally {
    await db.rateSnapshot.deleteMany({
      where: { anchor: { slug: retiredAnchorSlug } },
    });
    await db.anchorCorridor.deleteMany({
      where: { anchor: { slug: anchorSlug }, corridor: { slug: corridorSlug } },
    });
    await db.anchor.deleteMany({
      where: { slug: { in: [anchorSlug, retiredAnchorSlug] } },
    });
    await db.corridor.deleteMany({
      where: { slug: { in: [corridorSlug, retiredCorridorSlug] } },
    });
    await db.$disconnect();
  }
});
