import assert from "node:assert/strict";
import test from "node:test";

import { OPERATOR_ACTION_LIMITS } from "@/constants/audit";
import {
  PRISMA_OPERATOR_ACTION_LEDGER,
  boundLimit,
} from "@/lib/audit/ledgerRepository";

test("the ledger interface exposes no mutation methods", () => {
  const keys = Object.keys(PRISMA_OPERATOR_ACTION_LEDGER);
  assert.deepEqual(keys.sort(), ["append", "inspect", "listByRun", "listByTarget", "listRecent"]);
});

test("inspection limits are finite, positive, and capped", () => {
  assert.equal(boundLimit(undefined), OPERATOR_ACTION_LIMITS.inspectionDefaultLimit);
  assert.equal(boundLimit(Number.NaN), OPERATOR_ACTION_LIMITS.inspectionDefaultLimit);
  assert.equal(boundLimit(0), 1);
  assert.equal(boundLimit(-10), 1);
  assert.equal(boundLimit(10.9), 10);
  assert.equal(boundLimit(1_000_000), OPERATOR_ACTION_LIMITS.inspectionMaxLimit);
});
