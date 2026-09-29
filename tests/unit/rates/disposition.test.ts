import assert from "node:assert/strict";
import test from "node:test";

import {
  planDisposition,
  REASONS_BY_ACTION,
  stateAfterAction,
  toBlockingDisposition,
  validateDispositionRequest,
  type DispositionAction,
  type DispositionRequest,
  type DispositionSubject,
} from "@/lib/rates/disposition";

const TARGET = "11111111-1111-4111-8111-111111111111";
const LATER = "22222222-2222-4222-8222-222222222222";

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    action: "INVALIDATE",
    snapshotId: TARGET,
    reasonCode: "SEMANTICALLY_INCORRECT",
    reviewReference: "https://github.com/Aboyeji-Isaac/StellarCore/issues/121",
    actor: "maintainer-1",
    ...overrides,
  };
}

function valid(overrides: Partial<Record<string, unknown>> = {}): DispositionRequest {
  const result = validateDispositionRequest(request(overrides));
  assert.ok(result.ok, JSON.stringify(result));
  return result.request;
}

function subject(overrides: Partial<DispositionSubject> = {}): DispositionSubject {
  return {
    id: TARGET,
    anchorId: "anchor-a",
    corridorId: "corridor-a",
    capturedAt: new Date("2026-09-29T10:00:00.000Z"),
    lastAction: null,
    lastSequence: 0,
    ...overrides,
  };
}

test("the transition table matches the reviewed state machine", () => {
  const expected: Record<string, Partial<Record<DispositionAction, string>>> = {
    active: { QUARANTINE: "quarantined", INVALIDATE: "invalidated", SUPERSEDE: "superseded" },
    quarantined: { RELEASE: "active", INVALIDATE: "invalidated", SUPERSEDE: "superseded" },
    invalidated: {},
    superseded: {},
  };
  const lastActionFor = { active: null, quarantined: "QUARANTINE", invalidated: "INVALIDATE", superseded: "SUPERSEDE" } as const;
  const replacement = subject({ id: LATER, capturedAt: new Date("2026-09-29T11:00:00.000Z") });

  for (const [from, allowed] of Object.entries(expected)) {
    for (const action of ["QUARANTINE", "INVALIDATE", "SUPERSEDE", "RELEASE"] as const) {
      const req = valid({
        action,
        reasonCode: REASONS_BY_ACTION[action][0],
        ...(action === "SUPERSEDE" ? { supersededBySnapshotId: LATER } : {}),
      });
      const plan = planDisposition(
        req,
        subject({ lastAction: lastActionFor[from as keyof typeof lastActionFor], lastSequence: from === "active" ? 0 : 1 }),
        replacement,
      );
      if (allowed[action]) {
        assert.deepEqual(plan, {
          ok: true,
          fromState: from,
          toState: allowed[action],
          sequence: from === "active" ? 1 : 2,
        }, `${from} + ${action}`);
      } else {
        assert.deepEqual(plan, { ok: false, code: "ILLEGAL_TRANSITION" }, `${from} + ${action}`);
      }
    }
  }
});

test("a released snapshot is active again and can be quarantined again", () => {
  assert.equal(stateAfterAction("RELEASE"), "active");
  const plan = planDisposition(
    valid({ action: "QUARANTINE", reasonCode: "SUSPECTED_INCORRECT_VALUE" }),
    subject({ lastAction: "RELEASE", lastSequence: 2 }),
    null,
  );
  assert.deepEqual(plan, { ok: true, fromState: "active", toState: "quarantined", sequence: 3 });
});

test("supersession requires a later, active capture of the same anchor and corridor", () => {
  const req = valid({ action: "SUPERSEDE", reasonCode: "NORMALIZATION_DEFECT", supersededBySnapshotId: LATER });
  const later = new Date("2026-09-29T11:00:00.000Z");
  const cases: [Partial<DispositionSubject> | null, string][] = [
    [null, "REPLACEMENT_NOT_FOUND"],
    [{ anchorId: "anchor-b", capturedAt: later }, "INCOMPATIBLE_REPLACEMENT"],
    [{ corridorId: "corridor-b", capturedAt: later }, "INCOMPATIBLE_REPLACEMENT"],
    [{ capturedAt: new Date("2026-09-29T10:00:00.000Z") }, "REPLACEMENT_NOT_LATER"],
    [{ capturedAt: new Date("2026-09-29T09:00:00.000Z") }, "REPLACEMENT_NOT_LATER"],
    [{ capturedAt: later, lastAction: "INVALIDATE", lastSequence: 1 }, "REPLACEMENT_NOT_ACTIVE"],
    [{ capturedAt: later, lastAction: "QUARANTINE", lastSequence: 1 }, "REPLACEMENT_NOT_ACTIVE"],
    [{ capturedAt: later, lastAction: "SUPERSEDE", lastSequence: 1 }, "REPLACEMENT_NOT_ACTIVE"],
  ];
  for (const [overrides, code] of cases) {
    const replacement = overrides ? subject({ id: LATER, ...overrides }) : null;
    assert.deepEqual(planDisposition(req, subject(), replacement), { ok: false, code }, code);
  }
  assert.equal(planDisposition(req, subject(), subject({ id: LATER, capturedAt: later, lastAction: "RELEASE", lastSequence: 2 })).ok, true);
  assert.deepEqual(planDisposition(req, null, null), { ok: false, code: "SNAPSHOT_NOT_FOUND" });
});

test("requests are validated with bounded reason codes, references, actors, and notes", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ action: "DELETE" }, "INVALID_ACTION"],
    [{ snapshotId: "not-a-uuid" }, "INVALID_SNAPSHOT_ID"],
    [{ reasonCode: "REVIEW_CLEARED" }, "INVALID_REASON"],
    [{ reasonCode: "because I said so" }, "INVALID_REASON"],
    [{ reviewReference: "" }, "INVALID_REVIEW_REFERENCE"],
    [{ reviewReference: "has spaces" }, "INVALID_REVIEW_REFERENCE"],
    [{ reviewReference: "x".repeat(201) }, "INVALID_REVIEW_REFERENCE"],
    [{ actor: undefined }, "INVALID_ACTOR"],
    [{ actor: "evil; rm -rf /" }, "INVALID_ACTOR"],
    [{ note: "x".repeat(501) }, "INVALID_NOTE"],
    [{ note: "bell\u0007" }, "INVALID_NOTE"],
    [{ note: 42 }, "INVALID_NOTE"],
    [{ supersededBySnapshotId: LATER }, "REPLACEMENT_NOT_ALLOWED"],
    [{ action: "SUPERSEDE", reasonCode: "NORMALIZATION_DEFECT" }, "REPLACEMENT_REQUIRED"],
    [{ action: "SUPERSEDE", reasonCode: "NORMALIZATION_DEFECT", supersededBySnapshotId: TARGET.toUpperCase() }, "SELF_SUPERSESSION"],
  ];
  for (const [overrides, code] of cases) {
    assert.deepEqual(validateDispositionRequest(request(overrides)), { ok: false, code }, code);
  }

  const normalized = valid({ note: "  multi\n line\t note  ", snapshotId: TARGET.toUpperCase() });
  assert.equal(normalized.note, "multi line note");
  assert.equal(normalized.snapshotId, TARGET);
  assert.equal("note" in valid({ note: "   " }), false);
});

test("only blocking states produce a public disposition", () => {
  const at = new Date("2026-09-29T12:00:00.000Z");
  assert.equal(toBlockingDisposition(null, null, null), null);
  assert.equal(toBlockingDisposition("RELEASE", "REVIEW_CLEARED", at), null);
  assert.deepEqual(toBlockingDisposition("INVALIDATE", "SOURCE_COMPROMISED", at), {
    state: "invalidated",
    reasonCode: "SOURCE_COMPROMISED",
    recordedAt: at.toISOString(),
  });
  assert.equal(toBlockingDisposition("QUARANTINE", "SUSPECTED_INCORRECT_VALUE", at)?.state, "quarantined");
  assert.equal(toBlockingDisposition("SUPERSEDE", "NORMALIZATION_DEFECT", at)?.state, "superseded");
});
