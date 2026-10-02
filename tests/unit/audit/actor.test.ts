import assert from "node:assert/strict";
import test from "node:test";

import { isValidActorId, operatorActorColumns } from "@/lib/audit/actor";
import { OPERATOR_ACTION_LIMITS } from "@/constants/audit";

test("system actions never carry an invented human identity", () => {
  assert.deepEqual(operatorActorColumns({ kind: "system" }), {
    actorType: "SYSTEM",
    actorId: null,
  });
});

test("human actions carry only the supplied identity", () => {
  assert.deepEqual(operatorActorColumns({ kind: "human", id: "operator-42" }), {
    actorType: "HUMAN",
    actorId: "operator-42",
  });
});

test("actor ids are bounded and control-character free", () => {
  assert.equal(isValidActorId("operator-42"), true);
  assert.equal(isValidActorId(""), false);
  assert.equal(isValidActorId("   "), false);
  assert.equal(isValidActorId("a".repeat(OPERATOR_ACTION_LIMITS.actorIdMaxLength + 1)), false);
  assert.equal(isValidActorId("line\nbreak"), false);
  assert.equal(isValidActorId("tab\tbreak"), false);
});
