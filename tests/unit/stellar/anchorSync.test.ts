import assert from "node:assert/strict";
import test from "node:test";

import { AnchorStatus } from "@/app/generated/prisma/enums";
import {
  syncAnchorRegistry,
  type AnchorSyncDependencies,
  type PersistedAnchor,
} from "@/lib/stellar/anchorSync";
import { Sep1DiscoveryError } from "@/lib/stellar/sep1";
import type {
  AnchorRegistryEntry,
  DiscoveredAnchor,
} from "@/types/anchor";

const MONEYGRAM = Object.freeze({
  slug: "moneygram",
  name: "MoneyGram",
  homeDomain: "mgxanchor.moneygram.com",
}) satisfies AnchorRegistryEntry;

const COWRIE = Object.freeze({
  slug: "cowrie",
  name: "Cowrie",
  homeDomain: "cowrie.exchange",
}) satisfies AnchorRegistryEntry;

test("a successful discovery is persisted and reported", async () => {
  const persisted: string[] = [];
  const dependencies = createDependencies({
    persist: async (anchor) => {
      persisted.push(anchor.slug);
      return toPersisted(anchor);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.deepEqual(persisted, ["moneygram"]);
  assert.deepEqual(result, {
    totalAttempted: 1,
    succeeded: 1,
    failed: 0,
    successfulSlugs: ["moneygram"],
    failures: [],
  });
});

test("repeated synchronization upserts by slug without duplicates", async () => {
  const rows = new Map<string, PersistedAnchor>();
  const dependencies = createDependencies({
    persist: async (anchor) => {
      const persisted = toPersisted(anchor);
      rows.set(anchor.slug, persisted);
      return persisted;
    },
  });

  await syncAnchorRegistry([MONEYGRAM], dependencies);
  await syncAnchorRegistry([MONEYGRAM], dependencies);

  assert.equal(rows.size, 1);
  assert.equal(rows.get("moneygram")?.status, AnchorStatus.LIVE);
});

test("one discovery failure does not prevent another anchor succeeding", async () => {
  const dependencies = createDependencies({
    discover: async (entry) => {
      if (entry.slug === "moneygram") {
        throw new Sep1DiscoveryError(
          "TIMEOUT",
          "safe timeout",
          "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
        );
      }

      return makeDiscovered(entry);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM, COWRIE], dependencies);

  assert.equal(result.succeeded, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(result.successfulSlugs, ["cowrie"]);
  assert.deepEqual(result.failures, [
    {
      slug: "moneygram",
      phase: "DISCOVERY",
      code: "TIMEOUT",
      statusUpdate: "NOT_FOUND",
    },
  ]);
});

test("an existing failed anchor is marked DOWN without replacing metadata", async () => {
  const previous = toPersisted(makeDiscovered(MONEYGRAM));
  const rows = new Map<string, PersistedAnchor>([[MONEYGRAM.slug, previous]]);
  const dependencies = createDependencies({
    discover: async () => {
      throw new Sep1DiscoveryError(
        "INVALID_TOML",
        "safe invalid TOML",
        "https://mgxanchor.moneygram.com/.well-known/stellar.toml",
      );
    },
    markDown: async (slug) => {
      const existing = rows.get(slug);

      if (!existing) return "NOT_FOUND";

      rows.set(slug, Object.freeze({ ...existing, status: AnchorStatus.DOWN }));
      return "MARKED_DOWN";
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);
  const updated = rows.get(MONEYGRAM.slug);

  assert.equal(result.failures[0]?.statusUpdate, "MARKED_DOWN");
  assert.equal(updated?.status, AnchorStatus.DOWN);
  assert.equal(updated?.tomlUrl, previous.tomlUrl);
  assert.deepEqual(updated?.seps, previous.seps);
  assert.equal(updated?.isTransferCapable, previous.isTransferCapable);
});

test("egress-policy rejection is not recorded as anchor downtime", async () => {
  let markDownCalls = 0;
  const result = await syncAnchorRegistry([MONEYGRAM], {
    discover: async () => {
      throw new Sep1DiscoveryError(
        "EGRESS_POLICY",
        "blocked by policy",
        "https://anchor.example/.well-known/stellar.toml",
      );
    },
    allocateOrder: async () => BigInt(1),
    persist: async () => {
      throw new Error("must not persist");
    },
    markDown: async () => {
      markDownCalls += 1;
      return "MARKED_DOWN";
    },
  });

  assert.equal(markDownCalls, 0);
  assert.equal(result.failures[0]?.code, "EGRESS_POLICY");
  assert.equal(result.failures[0]?.statusUpdate, "NOT_ATTEMPTED");
});

test("structured failures omit unsafe error details", async () => {
  const dependencies = createDependencies({
    discover: async () => {
      throw new Error("DATABASE_URL=do-not-expose");
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM], dependencies);
  const serialized = JSON.stringify(result);

  assert.equal(result.failures[0]?.code, "UNEXPECTED_ERROR");
  assert.equal(serialized.includes("DATABASE_URL"), false);
  assert.equal(serialized.includes("do-not-expose"), false);
});

test("late older discovery is rejected after a newer synchronization commits", async () => {
  let nextOrder = BigInt(0);
  let discoveryCalls = 0;
  let releaseOld!: () => void;
  const oldReady = new Promise<void>((resolve) => { releaseOld = resolve; });
  let row: { order: bigint; anchor: DiscoveredAnchor } | undefined;
  const dependencies = createDependencies({
    allocateOrder: async () => ++nextOrder,
    discover: async (entry) => {
      const call = ++discoveryCalls;
      if (call === 1) await oldReady;
      return Object.freeze({ ...makeDiscovered(entry), name: call === 1 ? "Old discovery" : "New discovery" });
    },
    persist: async (anchor, order) => {
      if (row && row.order >= order) return null;
      row = { order, anchor };
      return toPersisted(anchor);
    },
  });

  const older = syncAnchorRegistry([MONEYGRAM], dependencies);
  await Promise.resolve();
  const newer = await syncAnchorRegistry([MONEYGRAM], dependencies);
  releaseOld();
  const olderResult = await older;

  assert.equal(row?.anchor.name, "New discovery");
  assert.equal(newer.succeeded, 1);
  assert.equal(olderResult.failures[0]?.code, "STALE_WRITE_REJECTED");
});

test("late older discovery failure cannot downgrade a newer successful synchronization", async () => {
  let nextOrder = BigInt(0);
  let releaseOld!: () => void;
  const oldReady = new Promise<void>((resolve) => { releaseOld = resolve; });
  let row: { order: bigint; status: AnchorStatus } = { order: BigInt(0), status: AnchorStatus.DOWN };
  const dependencies = createDependencies({
    allocateOrder: async () => ++nextOrder,
    discover: async (entry) => {
      if (nextOrder === BigInt(1)) {
        await oldReady;
        throw new Sep1DiscoveryError("TIMEOUT", "safe timeout", "https://example.com/stellar.toml");
      }
      return makeDiscovered(entry);
    },
    persist: async (anchor, order) => {
      if (order > row.order) row = { order, status: AnchorStatus.LIVE };
      return order === row.order ? toPersisted(anchor) : null;
    },
    markDown: async (_slug, order) => {
      if (order <= row.order) return "STALE";
      row = { order, status: AnchorStatus.DOWN };
      return "MARKED_DOWN";
    },
  });

  const older = syncAnchorRegistry([MONEYGRAM], dependencies);
  await Promise.resolve();
  await syncAnchorRegistry([MONEYGRAM], dependencies);
  releaseOld();
  const olderResult = await older;

  assert.equal(row.status, AnchorStatus.LIVE);
  assert.equal(olderResult.failures[0]?.statusUpdate, "STALE");
});

test("unexpected persistence errors are isolated from later anchors", async () => {
  const dependencies = createDependencies({
    persist: async (anchor) => {
      if (anchor.slug === "moneygram") throw new Error("database unavailable");
      return toPersisted(anchor);
    },
  });

  const result = await syncAnchorRegistry([MONEYGRAM, COWRIE], dependencies);

  assert.deepEqual(result.successfulSlugs, ["cowrie"]);
  assert.deepEqual(result.failures, [
    {
      slug: "moneygram",
      phase: "PERSISTENCE",
      code: "PERSISTENCE_FAILURE",
      statusUpdate: "NOT_ATTEMPTED",
    },
  ]);
});

function createDependencies(
  overrides: Partial<AnchorSyncDependencies> = {},
): AnchorSyncDependencies {
  return {
    allocateOrder: async () => BigInt(1),
    discover: async (entry) => makeDiscovered(entry),
    persist: async (anchor) => toPersisted(anchor),
    markDown: async () => "NOT_FOUND",
    ...overrides,
  };
}

function makeDiscovered(entry: AnchorRegistryEntry): DiscoveredAnchor {
  return Object.freeze({
    ...entry,
    tomlUrl: `https://${entry.homeDomain}/.well-known/stellar.toml`,
    organizationName: entry.name,
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    seps: Object.freeze([1, 10, 24] as const),
    isTransferCapable: true,
    endpoints: Object.freeze({}),
    assets: Object.freeze([]),
  });
}

function toPersisted(anchor: DiscoveredAnchor): PersistedAnchor {
  return Object.freeze({
    slug: anchor.slug,
    name: anchor.name,
    homeDomain: anchor.homeDomain,
    tomlUrl: anchor.tomlUrl,
    seps: Object.freeze([...anchor.seps]),
    isTransferCapable: anchor.isTransferCapable,
    status: AnchorStatus.LIVE,
  });
}
