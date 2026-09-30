import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  recordAnchorFailureEvidence,
  recordAnchorSuccessEvidence,
} from "@/lib/stellar/anchorSync";

const DATABASE_INTEGRATION_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

test("anchor health evidence survives process restarts through the persisted state row", {
  skip: !DATABASE_INTEGRATION_ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const suffix = randomUUID().replaceAll("-", "");
  const anchorSlug = `test-anchor-health-${suffix}`;

  try {
    const anchor = await db.anchor.create({
      data: {
        slug: anchorSlug,
        name: "Anchor Health Integration Fixture",
        homeDomain: `${suffix}.example.com`,
        tomlUrl: `https://${suffix}.example.com/.well-known/stellar.toml`,
        status: "LIVE",
        seps: [1, 10, 24],
      },
      select: { id: true },
    });

    // Worker one: two transient failures escalate LIVE -> DEGRADED. The
    // first failure records evidence and keeps the healthy status.
    const firstFailure = await recordAnchorFailureEvidence(
      anchorSlug,
      "TRANSIENT",
      "TIMEOUT",
    );
    assert.ok(firstFailure.kind === "RECORDED" && firstFailure.status === "LIVE");

    const secondFailure = await recordAnchorFailureEvidence(
      anchorSlug,
      "TRANSIENT",
      "TIMEOUT",
    );
    assert.ok(secondFailure.kind === "RECORDED" && secondFailure.status === "DEGRADED");

    const persistedAfterWorkerOne = await db.anchor.findUnique({
      where: { slug: anchorSlug },
      select: { status: true },
    });
    assert.equal(persistedAfterWorkerOne?.status, "DEGRADED");

    // Worker two (a "restarted" process re-reads persisted evidence only):
    // one more failure publishes DOWN deterministically.
    const thirdFailure = await recordAnchorFailureEvidence(
      anchorSlug,
      "TRANSIENT",
      "NETWORK_FAILURE",
    );
    assert.ok(thirdFailure.kind === "RECORDED" && thirdFailure.status === "DOWN");

    // Recovery requires two consecutive successes across separate runs.
    const firstSuccess = await recordAnchorSuccessEvidence(anchorSlug);
    assert.ok(firstSuccess.kind === "RECORDED" && firstSuccess.status === "DEGRADED");

    const secondSuccess = await recordAnchorSuccessEvidence(anchorSlug);
    assert.ok(secondSuccess.kind === "RECORDED" && secondSuccess.status === "LIVE");

    const healthRow = await db.anchorHealthState.findUnique({
      where: { anchorId: anchor.id },
    });
    assert.ok(healthRow);
    assert.equal(healthRow.status, "LIVE");
    assert.equal(healthRow.consecutiveFailures, 0);
    assert.equal(healthRow.lastFailureClass, null);
    assert.ok(healthRow.lastSuccessAt);
  } finally {
    await db.anchor.deleteMany({ where: { slug: anchorSlug } });
    await db.$disconnect();
  }
});
