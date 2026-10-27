import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { AnchorStatus } from "@/app/generated/prisma/enums";
import {
  allocateAnchorSyncOrder,
  markAnchorDownIfExists,
  persistDiscoveredAnchor,
} from "@/lib/stellar/anchorSync";
import type { DiscoveredAnchor } from "@/types/anchor";

const ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("database atomically rejects out-of-order success and failure writes", { skip: !ENABLED }, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const slug = `test-sync-order-${suffix}`;
  const anchor = (name: string): DiscoveredAnchor => Object.freeze({
    slug,
    name,
    homeDomain: `${suffix}.example.com`,
    tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
    organizationName: name,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    seps: Object.freeze([1, 10, 24] as const),
    isTransferCapable: true,
    endpoints: Object.freeze({}),
    assets: Object.freeze([]),
  });

  try {
    const oldOrder = await allocateAnchorSyncOrder();
    const newOrder = await allocateAnchorSyncOrder();
    assert.ok(newOrder > oldOrder);

    // Simulate the newer discovery finishing first, on pooled database connections.
    assert.ok(await persistDiscoveredAnchor(anchor("newer"), newOrder));
    assert.equal(await persistDiscoveredAnchor(anchor("older"), oldOrder), null);
    assert.equal(await persistDiscoveredAnchor(anchor("equal-order retry"), newOrder), null);
    assert.equal(await markAnchorDownIfExists(slug, oldOrder), "STALE");

    const saved = await db.anchor.findUniqueOrThrow({ where: { slug } });
    assert.equal(saved.name, "newer");
    assert.equal(saved.status, AnchorStatus.LIVE);
    assert.equal(saved.lastSyncOrder, newOrder);
  } finally {
    await db.anchor.deleteMany({ where: { slug } });
    await db.$disconnect();
  }
});
