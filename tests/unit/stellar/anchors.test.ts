import assert from "node:assert/strict";
import test from "node:test";

import { SEPS } from "@/constants/seps";
import { transferCapable } from "@/lib/stellar/anchors";

test("returns false for anchors with SEP-1 only", () => {
  assert.equal(transferCapable([SEPS.SEP_1]), false);
});

test("returns true for anchors with SEP-6", () => {
  assert.equal(transferCapable([SEPS.SEP_6]), true);
});

test("returns true for anchors with SEP-24", () => {
  assert.equal(transferCapable([SEPS.SEP_24]), true);
});

test("returns true for anchors with SEP-31", () => {
  assert.equal(transferCapable([SEPS.SEP_31]), true);
});

test("returns false for anchors with no SEPs", () => {
  assert.equal(transferCapable([]), false);
});

test("returns true when multiple transfer SEPs are present", () => {
  assert.equal(
    transferCapable([SEPS.SEP_6, SEPS.SEP_24, SEPS.SEP_31]),
    true,
  );
});