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

    const list = await getAnchorsApiResult();
    const detail = await getAnchorApiResult(anchorSlug);
    const registryOnly = await getAnchorApiResult(registryOnlySlug);

    assert.equal(list.status, 200);
    assert.equal(detail.status, 200);
    assert.equal(registryOnly.status, 404);
    if (list.status !== 200 || detail.status !== 200) return;
    const listed = list.body.anchors.find(({ slug }) => slug === anchorSlug);
    assert.equal(listed?.corridorCount, 1);
    assert.deepEqual(listed?.seps, [1, 24, 38]);
    assert.equal(detail.body.anchor.status, "DEGRADED");
    assert.deepEqual(detail.body.anchor.corridors, [{
      slug: corridorSlug,
      sourceAsset: "USDC",
      sourceCountry: "US",
      destinationAsset: "BRL",
      destinationCountry: "BR",
    }]);
  } finally {
    await db.anchorCorridor.deleteMany({
      where: { anchor: { slug: anchorSlug }, corridor: { slug: corridorSlug } },
    });
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.corridor.deleteMany({ where: { slug: corridorSlug } });
    await db.$disconnect();
  }
});
