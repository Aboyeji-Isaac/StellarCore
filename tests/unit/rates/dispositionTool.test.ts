import assert from "node:assert/strict";
import test from "node:test";

import type {
  DispositionRepository,
  DispositionSnapshotRecord,
  NewDispositionEvent,
} from "@/lib/rates/dispositionRepository";
import { classifyPersistenceError, inspectSnapshot, runDisposition } from "@/lib/rates/dispositionTool";
import { parseArguments } from "@/scripts/rate-disposition";

const TARGET = "11111111-1111-4111-8111-111111111111";

const SNAPSHOT: DispositionSnapshotRecord = Object.freeze({
  id: TARGET,
  anchorId: "anchor-a",
  corridorId: "corridor-a",
  anchorSlug: "anchor-a",
  corridorSlug: "usdc-us-brl-br",
  rate: "5.1",
  capturedAt: new Date("2026-09-29T10:00:00.000Z"),
  lastAction: null,
  lastSequence: 0,
  events: [],
});

function fakeRepository(appended: NewDispositionEvent[]): DispositionRepository {
  const tx = {
    findSnapshot: async (id: string) => (id === TARGET ? SNAPSHOT : null),
    append: async (event: NewDispositionEvent) => {
      appended.push(event);
      return {
        id: "event-1",
        sequence: event.sequence,
        action: event.action,
        reasonCode: event.reasonCode,
        reviewReference: event.reviewReference,
        actor: event.actor,
        note: event.note ?? null,
        supersededBySnapshotId: null,
        recordedAt: new Date("2026-09-29T12:00:00.000Z"),
      };
    },
  };
  return { findSnapshot: tx.findSnapshot, withTransaction: (work) => work(tx) };
}

const INPUT = Object.freeze({
  action: "QUARANTINE",
  snapshotId: TARGET,
  reasonCode: "SUSPECTED_INCORRECT_VALUE",
  reviewReference: "GH-121",
  actor: "maintainer",
});

test("a dry run validates and plans without appending", async () => {
  const appended: NewDispositionEvent[] = [];
  const result = await runDisposition(INPUT, { apply: false, repository: fakeRepository(appended) });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.mode, "dry-run");
  assert.equal(result.fromState, "active");
  assert.equal(result.toState, "quarantined");
  assert.equal(result.snapshot.reviewed, false);
  assert.equal(appended.length, 0);
});

test("apply appends exactly one event with the planned sequence", async () => {
  const appended: NewDispositionEvent[] = [];
  const result = await runDisposition(INPUT, { apply: true, repository: fakeRepository(appended) });
  assert.equal(result.ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.sequence, 1);
  assert.equal(appended[0]!.snapshotId, TARGET);
});

test("invalid input and missing snapshots fail before any database write", async () => {
  const appended: NewDispositionEvent[] = [];
  const repository = fakeRepository(appended);
  assert.deepEqual(
    await runDisposition({ ...INPUT, reasonCode: "REVIEW_CLEARED" }, { apply: true, repository }),
    { ok: false, code: "INVALID_REASON" },
  );
  assert.deepEqual(
    await runDisposition({ ...INPUT, snapshotId: "22222222-2222-4222-8222-222222222222" }, { apply: true, repository }),
    { ok: false, code: "SNAPSHOT_NOT_FOUND" },
  );
  assert.equal(appended.length, 0);
  assert.deepEqual(await inspectSnapshot("nope", repository), { ok: false, code: "INVALID_SNAPSHOT_ID" });
});

test("database errors map to bounded codes without echoing messages", async () => {
  assert.equal(classifyPersistenceError({ code: "P2002" }), "CONCURRENT_MODIFICATION");
  assert.equal(classifyPersistenceError({ code: "P2034" }), "CONCURRENT_MODIFICATION");
  assert.equal(classifyPersistenceError(new Error("ERROR: could not serialize access")), "CONCURRENT_MODIFICATION");
  assert.equal(classifyPersistenceError(new Error("violates check constraint \"x\"")), "REJECTED_BY_DATABASE");
  assert.equal(classifyPersistenceError(new Error("postgresql://user:secret@host")), "PERSISTENCE_FAILURE");

  const failing: DispositionRepository = {
    findSnapshot: async () => { throw new Error("postgresql://user:secret@host"); },
    withTransaction: async () => { throw new Error("postgresql://user:secret@host"); },
  };
  assert.deepEqual(await runDisposition(INPUT, { apply: true, repository: failing }), {
    ok: false,
    code: "PERSISTENCE_FAILURE",
  });
});

test("the CLI parser accepts known flags once and rejects anything else", () => {
  assert.deepEqual(parseArguments(["invalidate", "--snapshot", TARGET, "--reason", "SOURCE_COMPROMISED", "--apply"]), {
    ok: true,
    command: "invalidate",
    apply: true,
    values: { snapshotId: TARGET, reasonCode: "SOURCE_COMPROMISED" },
  });
  assert.deepEqual(parseArguments([]), { ok: false });
  assert.deepEqual(parseArguments(["invalidate", "--unknown", "x"]), { ok: false });
  assert.deepEqual(parseArguments(["invalidate", "--snapshot"]), { ok: false });
  assert.deepEqual(parseArguments(["invalidate", "--snapshot", "a", "--snapshot", "b"]), { ok: false });
});
