import assert from "node:assert/strict";
import test from "node:test";

import {
  formatRegistryDiff,
  summarizeRegistryDiff,
} from "@/scripts/registry-diff";

test("registry diff classifies additions, removals, and paired modifications", () => {
  const summary = summarizeRegistryDiff(
    "HEAD^",
    [
      "diff --git a/constants/anchors.ts b/constants/anchors.ts",
      "@@ -4,1 +4,1 @@",
      "-    name: \"Old Anchor\",",
      "+    name: \"New Anchor\",",
      "@@ -8,0 +9,1 @@",
      "+    slug: \"new-anchor\",",
      "@@ -12,1 +12,0 @@",
      "-    slug: \"removed-anchor\",",
    ].join("\n"),
  );

  assert.deepEqual(summary.modifications, [
    "constants/anchors.ts: name: \"Old Anchor\", -> name: \"New Anchor\"," ,
  ]);
  assert.deepEqual(summary.additions, [
    "constants/anchors.ts: slug: \"new-anchor\"," ,
  ]);
  assert.deepEqual(summary.removals, [
    "constants/anchors.ts: slug: \"removed-anchor\"," ,
  ]);
});

test("registry diff formatting is readable when there are no changes", () => {
  const output = formatRegistryDiff(summarizeRegistryDiff("v1", ""));

  assert.match(output, /Registry diff against v1/);
  assert.match(output, /No registry changes found\./);
});
