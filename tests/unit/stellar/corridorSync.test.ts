import assert from "node:assert/strict";
import test from "node:test";

import {
  CorridorAssociationError,
  syncCorridorRegistry,
  type AnchorCorridorAssociationResult,
  type CorridorSyncDependencies,
  type PersistedCorridor,
} from "@/lib/stellar/corridorSync";
import type {
  AnchorCorridorRegistryEntry,
  CorridorRegistryEntry,
} from "@/types/corridor";

const MONEYGRAM_CORRIDOR = Object.freeze({
  slug: "usdc-us-usd-us",
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "USD",
  countryTo: "US",
}) satisfies CorridorRegistryEntry;

const COWRIE_CORRIDOR = Object.freeze({
  slug: "ngnt-ng-ngn-ng",
  assetCodeFrom: "NGNT",
  countryFrom: "NG",
  assetCodeTo: "NGN",
  countryTo: "NG",
}) satisfies CorridorRegistryEntry;

const MAPPINGS = Object.freeze([
  Object.freeze({
    anchorSlug: "moneygram",
    corridorSlugs: Object.freeze([MONEYGRAM_CORRIDOR.slug]),
  }),
  Object.freeze({
    anchorSlug: "cowrie",
    corridorSlugs: Object.freeze([COWRIE_CORRIDOR.slug]),
  }),
]) satisfies readonly AnchorCorridorRegistryEntry[];

test("corridor upserts and association synchronization are idempotent", async () => {
  const state = createInMemoryState();

  const first = await syncCorridorRegistry(
    [MONEYGRAM_CORRIDOR, COWRIE_CORRIDOR],
    MAPPINGS,
    state.dependencies,
  );
  const second = await syncCorridorRegistry(
    [MONEYGRAM_CORRIDOR, COWRIE_CORRIDOR],
    MAPPINGS,
    state.dependencies,
  );

  assert.equal(state.corridors.size, 2);
  assert.equal(state.associations.get("moneygram")?.size, 1);
  assert.equal(state.associations.get("cowrie")?.size, 1);
  assert.equal(first.totalAssociations, 2);
  assert.equal(second.totalAssociations, 2);
  assert.deepEqual(second.failures, []);
});

test("association synchronization removes stale junctions", async () => {
  const state = createInMemoryState();
  state.associations.set(
    "moneygram",
    new Set([MONEYGRAM_CORRIDOR.slug, "stale-corridor"]),
  );

  const result = await syncCorridorRegistry(
    [MONEYGRAM_CORRIDOR],
    [MAPPINGS[0]],
    state.dependencies,
  );

  assert.deepEqual([...state.associations.get("moneygram")!], [
    MONEYGRAM_CORRIDOR.slug,
  ]);
  assert.equal(result.associationResults[0]?.staleAssociationsRemoved, 1);
});

test("one failed association does not corrupt unrelated associations", async () => {
  const state = createInMemoryState({ failedAnchorSlug: "moneygram" });

  const result = await syncCorridorRegistry(
    [MONEYGRAM_CORRIDOR, COWRIE_CORRIDOR],
    MAPPINGS,
    state.dependencies,
  );

  assert.equal(state.associations.has("moneygram"), false);
  assert.deepEqual([...state.associations.get("cowrie")!], [
    COWRIE_CORRIDOR.slug,
  ]);
  assert.deepEqual(result.failures, [
    {
      scope: "ASSOCIATION",
      slug: "moneygram",
      code: "ANCHOR_NOT_FOUND",
    },
  ]);
});

test("unexpected errors produce a safe structured failure", async () => {
  const state = createInMemoryState({
    unexpectedError: new Error("DATABASE_URL=do-not-expose"),
  });

  const result = await syncCorridorRegistry(
    [MONEYGRAM_CORRIDOR],
    [MAPPINGS[0]],
    state.dependencies,
  );
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.failures, [
    {
      scope: "ASSOCIATION",
      slug: "moneygram",
      code: "UNEXPECTED_ERROR",
    },
  ]);
  assert.equal(serialized.includes("DATABASE_URL"), false);
  assert.equal(serialized.includes("do-not-expose"), false);
});

function createInMemoryState(options: {
  failedAnchorSlug?: string;
  unexpectedError?: Error;
} = {}) {
  const corridors = new Map<string, PersistedCorridor>();
  const associations = new Map<string, Set<string>>();

  const dependencies: CorridorSyncDependencies = {
    upsertCorridor: async (corridor) => {
      const persisted = Object.freeze({ ...corridor });
      corridors.set(corridor.slug, persisted);
      return persisted;
    },
    syncAssociations: async (mapping) => {
      if (options.unexpectedError) throw options.unexpectedError;
      if (mapping.anchorSlug === options.failedAnchorSlug) {
        throw new CorridorAssociationError("ANCHOR_NOT_FOUND");
      }

      const previous = associations.get(mapping.anchorSlug) ?? new Set<string>();
      const desired = new Set(mapping.corridorSlugs);
      const staleAssociationsRemoved = [...previous].filter(
        (slug) => !desired.has(slug),
      ).length;
      associations.set(mapping.anchorSlug, desired);

      return freezeAssociationResult({
        anchorSlug: mapping.anchorSlug,
        corridorSlugs: mapping.corridorSlugs,
        associationCount: desired.size,
        staleAssociationsRemoved,
      });
    },
  };

  return { corridors, associations, dependencies };
}

function freezeAssociationResult(
  result: AnchorCorridorAssociationResult,
): AnchorCorridorAssociationResult {
  return Object.freeze({
    ...result,
    corridorSlugs: Object.freeze([...result.corridorSlugs]),
  });
}
