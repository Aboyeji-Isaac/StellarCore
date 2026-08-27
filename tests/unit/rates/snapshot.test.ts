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

test("repeated legitimate observations append historical snapshots", async () => {
  const state = repository();
  const first = await persistRateSnapshot(OBSERVATION, state.value);
  const second = await persistRateSnapshot(OBSERVATION, state.value);
  assert.equal(first.ok && first.snapshot.id, "snapshot-1");
  assert.equal(second.ok && second.snapshot.id, "snapshot-2");
  assert.equal(state.rows.length, 2);
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
      rows.push(input);
      return { id: `snapshot-${rows.length}`, ...input };
    },
  };
  return state;
}
