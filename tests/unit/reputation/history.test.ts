import assert from "node:assert/strict";
import test from "node:test";

import { listReputationHistory } from "@/lib/reputation/repository";

test("history reads enforce a bounded internal inspection limit before database access", async () => {
  await assert.rejects(listReputationHistory("anchor", 0), RangeError);
  await assert.rejects(listReputationHistory("anchor", 101), RangeError);
  await assert.rejects(listReputationHistory("anchor", 1.5), RangeError);
});
