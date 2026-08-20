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

      if (!existing) return false;

      rows.set(slug, Object.freeze({ ...existing, status: AnchorStatus.DOWN }));
      return true;
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
    discover: async (entry) => makeDiscovered(entry),
    persist: async (anchor) => toPersisted(anchor),
    markDown: async () => false,
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
