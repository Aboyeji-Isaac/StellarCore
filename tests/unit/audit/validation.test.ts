import assert from "node:assert/strict";
import test from "node:test";

import { OPERATOR_ACTION_LIMITS } from "@/constants/audit";
import { validateOperatorActionInput } from "@/lib/audit/validation";
import type { RecordOperatorActionInput } from "@/types/audit";

function input(overrides: Partial<RecordOperatorActionInput> = {}): RecordOperatorActionInput {
  return {
    actionType: "RATE_SNAPSHOT_INVALIDATED",
    targetType: "RATE_SNAPSHOT",
    targetId: "a3e2e6f0-0000-0000-0000-000000000000",
    targetLabel: "zeam/usdc-us-brl-br",
    reasonCode: "SOURCE_ERROR",
    rationale: "Reviewed source error",
    actor: { kind: "human", id: "operator-7" },
    runId: "run-2026-10-02",
    actionId: "action-1",
    ...overrides,
  };
}

test("a reviewed action passes validation", () => {
  assert.deepEqual(validateOperatorActionInput(input()), []);
});

test("unknown vocabulary values are rejected without echoing the value", () => {
  const secret = "Bearer super-secret-token";
  const issues = validateOperatorActionInput(input({
    actionType: "NOT_AN_ACTION" as never,
    reasonCode: secret as never,
  }));
  assert.equal(issues.some((issue) => issue.field === "actionType" && issue.code === "NOT_IN_VOCABULARY"), true);
  assert.equal(issues.some((issue) => issue.field === "reasonCode" && issue.code === "NOT_IN_VOCABULARY"), true);
  assert.equal(JSON.stringify(issues).includes("super-secret-token"), false);
});

test("target type must match the action's reviewed target", () => {
  const issues = validateOperatorActionInput(input({ targetType: "ANCHOR" }));
  assert.equal(issues.some((issue) => issue.code === "INCOMPATIBLE_TARGET"), true);
});

test("reason codes are restricted to the reviewed action", () => {
  const issues = validateOperatorActionInput(input({ reasonCode: "OPERATOR_RECOVERY" }));
  assert.equal(issues.some((issue) => issue.code === "REASON_NOT_ALLOWED"), true);
});

test("bounded text fields enforce length and reject control characters", () => {
  const tooLong = validateOperatorActionInput(input({
    rationale: "x".repeat(OPERATOR_ACTION_LIMITS.rationaleMaxLength + 1),
  }));
  assert.equal(tooLong.some((issue) => issue.field === "rationale" && issue.code === "TOO_LONG"), true);

  const control = validateOperatorActionInput(input({ rationale: "line\nbreak" }));
  assert.equal(control.some((issue) => issue.field === "rationale" && issue.code === "INVALID_FORMAT"), true);

  const empty = validateOperatorActionInput(input({ targetLabel: "   " }));
  assert.equal(empty.some((issue) => issue.field === "targetLabel" && issue.code === "EMPTY"), true);
});

test("identifiers must use the stable format and stay bounded", () => {
  assert.equal(
    validateOperatorActionInput(input({ actionId: "bad id!" }))
      .some((issue) => issue.field === "actionId" && issue.code === "INVALID_FORMAT"),
    true,
  );
  assert.equal(
    validateOperatorActionInput(input({ runId: "x".repeat(OPERATOR_ACTION_LIMITS.runIdMaxLength + 1) }))
      .some((issue) => issue.field === "runId" && issue.code === "TOO_LONG"),
    true,
  );
});

test("human actor ids are validated and system actors are always available", () => {
  assert.equal(
    validateOperatorActionInput(input({ actor: { kind: "human", id: "bad\nid" } }))
      .some((issue) => issue.field === "actor" && issue.code === "INVALID_ACTOR_ID"),
    true,
  );
  assert.deepEqual(validateOperatorActionInput(input({ actor: { kind: "system" } })), []);
});
