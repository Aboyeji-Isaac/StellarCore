import assert from "node:assert/strict";
import test from "node:test";

import { computeFreshMedian } from "@/lib/rates/median";
import {
  isValidAuthorityConfigurationVersion,
  isValidAuthorityDisplayName,
  isValidSourceAuthorityId,
  selectIndependentAuthorityObservations,
} from "@/lib/rates/sourceAuthority";
import type { LatestRateRepositoryObservation } from "@/types/latestRates";

const NOW = new Date("2026-09-28T12:00:00.000Z");

test("reviewed authority ids reject anything not opaque and pre-assigned", () => {
  assert.equal(isValidSourceAuthorityId("auth-0001"), true);
  assert.equal(isValidSourceAuthorityId("auth-1234"), true);
  for (const value of [
    "zeam",
    "auth-zeam",
    "auth-1",
    "auth-00001",
    "AUTH-0001",
    "auth-0001 ",
    "",
    null,
    undefined,
    42,
  ]) {
    assert.equal(isValidSourceAuthorityId(value), false, `expected ${String(value)} to be invalid`);
  }
});

test("reviewed authority display names and versions stay well-formed", () => {
  assert.equal(isValidAuthorityDisplayName("Zeam"), true);
  assert.equal(isValidAuthorityDisplayName(""), false);
  assert.equal(isValidAuthorityDisplayName("   "), false);
  assert.equal(isValidAuthorityDisplayName("bad\nlabel"), false);
  assert.equal(isValidAuthorityConfigurationVersion(1), true);
  assert.equal(isValidAuthorityConfigurationVersion(0), false);
  assert.equal(isValidAuthorityConfigurationVersion(1.5), false);
  assert.equal(isValidAuthorityConfigurationVersion(Number.NaN), false);
});

test("at most one observation per reviewed authority can reach the median", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("zeam", "a", "auth-0001", 1_000),
    observation("zeam-partner", "b", "auth-0001", 2_000),
    observation("other", "c", "auth-0002", 3_000),
  ], NOW);

  assert.equal(selection.independentAuthorityCount, 2);
  assert.deepEqual(
    selection.selected.map(({ authorityId }) => authorityId),
    ["auth-0001", "auth-0002"],
  );
  assert.deepEqual(
    selection.exclusions.map(({ observation: entry, reason }) => [entry.id, reason]),
    [["b", "correlated_same_authority"]],
  );
});

test("unknown authority observations are excluded rather than guessed", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("legacy-a", "a", null, 1_000),
    observation("legacy-b", "b", null, 2_000),
    observation("known", "c", "auth-0001", 3_000),
  ], NOW);

  assert.equal(selection.independentAuthorityCount, 1);
  assert.deepEqual(
    selection.exclusions.map(({ observation: entry, reason }) => [entry.id, reason]),
    [["a", "unknown_authority"], ["b", "unknown_authority"]],
  );
  assert.deepEqual(selection.selected.map(({ id }) => id), ["c"]);
});

test("a fresh representative wins over a stale correlated sibling", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("stale", "stale", "auth-0001", 120_001),
    observation("fresh", "fresh", "auth-0001", 1_000),
  ], NOW);

  assert.deepEqual(selection.selected.map(({ id }) => id), ["fresh"]);
  assert.deepEqual(
    selection.exclusions.map(({ observation: entry, reason }) => [entry.id, reason]),
    [["stale", "correlated_same_authority"]],
  );
});

test("correlated selection is deterministic and never averages values", () => {
  const correlated = [
    observation("a", "sibling-a", "auth-0001", 2_000, "10"),
    observation("b", "sibling-b", "auth-0001", 5_000, "20"),
  ];

  const selection = selectIndependentAuthorityObservations(correlated, NOW);
  assert.equal(selection.selected.length, 1);
  const representativeRate = selection.selected[0]!.rate;
  assert.ok(representativeRate === "10" || representativeRate === "20");
  assert.equal(representativeRate, "10");

  // Reversing the input must not change the chosen representative.
  const reversed = selectIndependentAuthorityObservations([...correlated].reverse(), NOW);
  assert.equal(reversed.selected[0]!.id, "sibling-a");
});

test("identical capture order falls back to the stable greater snapshot id", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("a", "00000000-0000-0000-0000-000000000001", "auth-0001", 1_000, "1"),
    observation("b", "00000000-0000-0000-0000-000000000002", "auth-0001", 1_000, "2"),
  ], NOW);

  assert.equal(selection.selected[0]!.id, "00000000-0000-0000-0000-000000000002");
});

test("selection output is deeply immutable", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("a", "a", "auth-0001", 1_000),
    observation("b", "b", "auth-0001", 2_000),
  ], NOW);

  assert.equal(Object.isFrozen(selection), true);
  assert.equal(Object.isFrozen(selection.selected), true);
  assert.equal(Object.isFrozen(selection.exclusions), true);
  assert.equal(Object.isFrozen(selection.exclusions[0]), true);
  assert.throws(() => {
    (selection.selected as unknown as unknown[]).push({});
  }, TypeError);
});

test("exact decimal median math is preserved once the independent set is chosen", () => {
  const selection = selectIndependentAuthorityObservations([
    observation("a", "a", "auth-0001", 500, "0.100000000000000001"),
    observation("a-sibling", "a2", "auth-0001", 1_000, "9"),
    observation("b", "b", "auth-0002", 1_500, "0.100000000000000002"),
  ], NOW);
  const median = computeFreshMedian(
    selection.selected.map((entry) => ({
      anchorSlug: entry.anchorSlug,
      corridorSlug: "usdc-us-brl-br",
      rate: entry.rate,
      capturedAt: entry.capturedAt,
    })),
    NOW,
  );

  assert.equal(median.median, "0.1000000000000000015");
  assert.equal(median.freshSourceCount, 2);
});

test("property: every observation lands once and independent count never exceeds distinct authorities", () => {
  const random = mulberry32(0x5eed);
  const authorityPool = ["auth-0001", "auth-0002", "auth-0003", "auth-0004"] as const;

  for (let iteration = 0; iteration < 300; iteration += 1) {
    const size = 1 + Math.floor(random() * 12);
    const input = Array.from({ length: size }, (_, index) =>
      observation(
        `anchor-${index}`,
        `snapshot-${iteration}-${index}`,
        random() < 0.25
          ? null
          : authorityPool[Math.floor(random() * authorityPool.length)]!,
        Math.floor(random() * 130_000),
        String(1 + Math.floor(random() * 5_000)),
      ));

    const selection = selectIndependentAuthorityObservations(input, NOW);
    const selectedIds = selection.selected.map(({ id }) => id);
    const excludedIds = selection.exclusions.map(({ observation: entry }) => entry.id);

    assert.equal(selectedIds.length + excludedIds.length, input.length);
    assert.deepEqual(
      new Set([...selectedIds, ...excludedIds]),
      new Set(input.map(({ id }) => id)),
    );

    const validAuthorities = new Set(
      input.map(({ authorityId }) => authorityId).filter((value): value is string =>
        isValidSourceAuthorityId(value)),
    );
    assert.equal(selection.independentAuthorityCount, selection.selected.length);
    assert.ok(selection.independentAuthorityCount <= validAuthorities.size);

    const selectedAuthorities = selection.selected.map(({ authorityId }) => authorityId);
    assert.equal(new Set(selectedAuthorities).size, selectedAuthorities.length);
    assert.ok(selectedAuthorities.every((value) => isValidSourceAuthorityId(value)));
    assert.ok(
      selection.exclusions.every(({ observation: entry }) =>
        entry.authorityId === null
          ? true
          : selectedAuthorities.filter((value) => value === entry.authorityId).length === 1),
    );
  }
});

test("property: selection is invariant under input permutation", () => {
  const random = mulberry32(0xc0ffee);

  for (let iteration = 0; iteration < 100; iteration += 1) {
    const size = 2 + Math.floor(random() * 8);
    const input = Array.from({ length: size }, (_, index) =>
      observation(
        `anchor-${index}`,
        `snapshot-${iteration}-${index}`,
        random() < 0.3 ? null : `auth-000${1 + Math.floor(random() * 3)}`,
        Math.floor(random() * 130_000),
        String(1 + Math.floor(random() * 100)),
      ));

    const forward = selectIndependentAuthorityObservations(input, NOW);
    const backward = selectIndependentAuthorityObservations([...input].reverse(), NOW);

    assert.deepEqual(forward.selected.map(({ id }) => id), backward.selected.map(({ id }) => id));
    assert.deepEqual(reasonMap(forward), reasonMap(backward));
    assert.equal(forward.independentAuthorityCount, backward.independentAuthorityCount);
  }
});

function reasonMap(
  selection: ReturnType<typeof selectIndependentAuthorityObservations>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    selection.exclusions.map(({ observation: entry, reason }) => [entry.id, reason]),
  );
}

function observation(
  anchorSlug: string,
  id: string,
  authorityId: string | null,
  ageMs: number,
  rate = "1",
): LatestRateRepositoryObservation {
  return Object.freeze({
    id,
    anchorSlug,
    anchorName: `${anchorSlug} persisted`,
    authorityId,
    authorityConfigurationVersion: authorityId === null ? null : 1,
    rate,
    sourceAmount: "1",
    destinationAmount: rate,
    fee: "0",
    capturedAt: new Date(NOW.getTime() - ageMs),
  });
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
