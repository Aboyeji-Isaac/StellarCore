import assert from "node:assert/strict";
import test from "node:test";

import { advertisedCapabilities } from "@/lib/stellar/advertisedCapabilities";

test("all approved SEP capability labels map from persisted SEP numbers", () => {
  const capabilities = advertisedCapabilities([38, 31, 24, 10, 6]);

  assert.deepEqual(capabilities, [
    { sep: 6, label: "SEP-6 transfer server advertised" },
    { sep: 10, label: "SEP-10 web-auth endpoint advertised" },
    { sep: 24, label: "SEP-24 interactive transfer server advertised" },
    { sep: 31, label: "SEP-31 direct-payment server advertised" },
    { sep: 38, label: "SEP-38 quote server advertised" },
  ]);
  assert.equal(Object.isFrozen(capabilities), true);
  assert.equal(Object.isFrozen(capabilities[0]), true);
});

test("unknown SEP numbers do not produce invented capability labels", () => {
  assert.deepEqual(advertisedCapabilities([1, 999]), []);
});
