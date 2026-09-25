import assert from "node:assert/strict";
import test from "node:test";

import { syncStatusPresentation } from "@/components/anchors/syncStatusPresentation";
import type { PublicAnchorStatus } from "@/types/api/anchors";

test("persisted synchronization state keeps the dashboard's Synced wording", () => {
  const expected: readonly Readonly<{
    status: PublicAnchorStatus;
    tone: string;
    label: string;
  }>[] = [
    { status: "LIVE", tone: "positive", label: "Synced" },
    { status: "DEGRADED", tone: "warning", label: "Sync degraded" },
    { status: "DOWN", tone: "negative", label: "Sync failed" },
    { status: "UNKNOWN", tone: "neutral", label: "Sync unknown" },
  ];

  for (const value of expected) {
    assert.deepEqual(
      syncStatusPresentation(value.status),
      { tone: value.tone, label: value.label },
      value.status,
    );
  }
});

test("no persisted state is ever labelled as live availability", () => {
  for (const status of ["LIVE", "DEGRADED", "DOWN", "UNKNOWN"] as const) {
    assert.doesNotMatch(syncStatusPresentation(status).label, /\blive\b/i);
  }
});
