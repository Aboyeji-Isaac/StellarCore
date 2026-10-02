import assert from "node:assert/strict";
import test from "node:test";

import {
  OPERATOR_ACTION_CATALOG,
  getOperatorActionDefinition,
  isOperatorActionType,
  isOperatorReasonCode,
  isOperatorTargetType,
  isReasonCodeAllowed,
  operatorActionTypes,
  operatorReasonCodes,
} from "@/lib/audit/vocabulary";

test("the catalog is unique, non-empty, and internally consistent", () => {
  const actionTypes = OPERATOR_ACTION_CATALOG.map((definition) => definition.actionType);
  assert.equal(new Set(actionTypes).size, actionTypes.length);

  for (const definition of OPERATOR_ACTION_CATALOG) {
    assert.equal(definition.reasonCodes.length > 0, true, definition.actionType);
    assert.equal(new Set(definition.reasonCodes).size, definition.reasonCodes.length);
    assert.equal(definition.description.trim().length > 0, true);
    assert.equal(getOperatorActionDefinition(definition.actionType), definition);
  }

  assert.deepEqual(operatorActionTypes(), actionTypes);
});

test("action and target types are validated against the vocabulary", () => {
  assert.equal(isOperatorActionType("ANCHOR_RETIRED"), true);
  assert.equal(isOperatorActionType("ANCHOR_LAUNCHED"), false);
  assert.equal(isOperatorActionType(undefined), false);

  assert.equal(isOperatorTargetType("RATE_SNAPSHOT"), true);
  assert.equal(isOperatorTargetType("OPERATOR"), false);

  assert.equal(isOperatorReasonCode("SOURCE_ERROR"), true);
  assert.equal(isOperatorReasonCode("BECAUSE"), false);
});

test("reason codes are only allowed for reviewed actions", () => {
  assert.equal(isReasonCodeAllowed("RATE_SNAPSHOT_INVALIDATED", "SOURCE_ERROR"), true);
  assert.equal(isReasonCodeAllowed("RATE_SNAPSHOT_INVALIDATED", "OPERATOR_RECOVERY"), false);
  assert.equal(isReasonCodeAllowed("ANCHOR_REACTIVATED", "OPERATOR_RECOVERY"), true);
  assert.equal(isReasonCodeAllowed("ANCHOR_REACTIVATED", "REVIEWED_CONFIGURATION_REMOVAL"), false);
});

test("reason code listing is sorted and unique", () => {
  const codes = operatorReasonCodes();
  assert.deepEqual([...codes], [...new Set(codes)]);
  assert.deepEqual([...codes], [...codes].sort((left, right) => left.localeCompare(right)));
});
