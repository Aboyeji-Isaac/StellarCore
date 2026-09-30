import assert from "node:assert/strict";
import test from "node:test";

import { persistRateSnapshot } from "@/lib/rates/snapshot";
import type {
  NormalizedRateObservation,
  RateSnapshotRepository,
} from "@/types/rates";

const OBSERVATION: NormalizedRateObservation = Object.freeze({
  anchorSlug: "moneygram",
  corridorSlug: "usdc-us-usd-us",
  rate: "1.01",
  sourceAmount: "100",
  destinationAmount: "101",
  fee: "1",
  capturedAt: new Date("2026-08-27T12:00:00.000Z"),
});

test("snapshot persistence resolves stable slugs and requires an existing association", async () => {
  const state = repository();
  await persistRateSnapshot(OBSERVATION, state.value);
  assert.deepEqual(state.lookups, ["anchor:moneygram", "corridor:usdc-us-usd-us", "association:a:c"]);

  state.associated = false;
  assert.deepEqual(await persistRateSnapshot(OBSERVATION, state.value), {
    ok: false,
    code: "ASSOCIATION_NOT_FOUND",
  });
});

test("missing anchor and missing corridor return safe structured failures", async () => {
  const missingAnchor = repository();
  missingAnchor.anchorExists = false;
  assert.deepEqual(await persistRateSnapshot(OBSERVATION, missingAnchor.value), { ok: false, code: "ANCHOR_NOT_FOUND" });

  const missingCorridor = repository();
  missingCorridor.corridorExists = false;
  assert.deepEqual(await persistRateSnapshot(OBSERVATION, missingCorridor.value), { ok: false, code: "CORRIDOR_NOT_FOUND" });
});

test("replaying the same captured observation stores one row and reports a replay", async () => {
  const state = repository();
  const first = await persistRateSnapshot(OBSERVATION, state.value);
  const replay = await persistRateSnapshot({ ...OBSERVATION }, state.value);
  assert.equal(first.ok && first.replayed, false);
  assert.equal(replay.ok && replay.replayed, true);
  assert.equal(replay.ok && replay.snapshot.id, "snapshot-1");
  assert.equal(state.rows.length, 1);
});

test("distinct observations with the same numeric rate both persist", async () => {
  const state = repository();
  const first = await persistRateSnapshot(OBSERVATION, state.value);
  const later = await persistRateSnapshot({
    ...OBSERVATION,
    capturedAt: new Date("2026-08-27T12:01:00.000Z"),
  }, state.value);
  assert.equal(first.ok && first.snapshot.id, "snapshot-1");
  assert.equal(later.ok && later.snapshot.id, "snapshot-2");
  assert.equal(later.ok && later.replayed, false);
  assert.equal(state.rows.length, 2);
});

test("a retry after an ambiguous persistence failure is safe", async () => {
  const state = repository();
  state.failAfterInsert = true;
  assert.deepEqual(await persistRateSnapshot(OBSERVATION, state.value), {
    ok: false,
    code: "PERSISTENCE_FAILURE",
  });
  state.failAfterInsert = false;
  const retry = await persistRateSnapshot(OBSERVATION, state.value);
  assert.equal(retry.ok && retry.replayed, true);
  assert.equal(state.rows.length, 1);
});

function repository() {
  const rows: Array<Record<string, unknown>> = [];
  const lookups: string[] = [];
  const state = {
    rows,
    lookups,
    anchorExists: true,
    corridorExists: true,
    associated: true,
    failAfterInsert: false,
    value: undefined as unknown as RateSnapshotRepository,
  };
  state.value = {
    findAnchorBySlug: async (slug) => {
      lookups.push(`anchor:${slug}`);
      return state.anchorExists ? { id: "a" } : null;
    },
    findCorridorBySlug: async (slug) => {
      lookups.push(`corridor:${slug}`);
      return state.corridorExists ? { id: "c" } : null;
    },
    hasAssociation: async (anchorId, corridorId) => {
      lookups.push(`association:${anchorId}:${corridorId}`);
      return state.associated;
    },
    createSnapshot: async (input) => {
      const index = rows.findIndex(
        (row) => row.observationKey === input.observationKey,
      );
      const replayed = index !== -1;
      if (!replayed) rows.push(input);
      const position = replayed ? index : rows.length - 1;
      if (state.failAfterInsert) throw new Error("connection lost after commit");
      return { id: `snapshot-${position + 1}`, ...input, replayed };
    },
  };
  return state;
}
