import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { persistDiscoveredAnchor } from "@/lib/stellar/anchorSync";
import { assessAgainstApprovedBaseline } from "@/lib/stellar/sep1HistoryRepository";
import { runReviewCli } from "../../../scripts/review-sep1";
import { parseSep1Toml } from "@/lib/stellar/sep1";
import type { DiscoveredAnchor } from "@/types/anchor";

const ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";

function toml(signingKey: string, quote = "https://quote.example.com/sep38"): string {
  return `NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
SIGNING_KEY = "${signingKey}"
ANCHOR_QUOTE_SERVER = "${quote}"
[DOCUMENTATION]
ORG_NAME = "Fixture"
[[CURRENCIES]]
code = "USDC"
issuer = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
`;
}

function discovered(slug: string, source: string): DiscoveredAnchor {
  const data = parseSep1Toml(source);
  return Object.freeze({
    slug,
    name: `Fixture ${slug}`,
    homeDomain: `${slug}.example.com`,
    tomlUrl: `https://${slug}.example.com/.well-known/stellar.toml`,
    organizationName: data.organizationName,
    networkPassphrase: data.networkPassphrase,
    seps: data.seps,
    isTransferCapable: false,
    endpoints: data.endpoints,
    ...(data.signingKey ? { signingKey: data.signingKey } : {}),
    assets: data.assets,
  });
}

test("SEP-1 history: baseline gating, quarantine, review and append-only enforcement", {
  skip: !ENABLED,
}, async () => {
  await import("dotenv/config");
  const { db } = await import("@/lib/dbClient");
  const slug = `sep1-hist-${randomUUID().replaceAll("-", "").slice(0, 16)}`;

  try {
    // First discovery of a legacy/new anchor: retained, no baseline available.
    const first = await persistDiscoveredAnchor(discovered(slug, toml("GKEYONE")));
    assert.equal(first.discovery?.assessment, "NO_BASELINE");
    assert.equal(
      (await assessAgainstApprovedBaseline(db, slug, discovered(slug, toml("GKEYONE")))).assessment,
      "NO_BASELINE",
    );

    const listed = JSON.parse((await runReviewCli(["list", slug], db)).output);
    assert.equal(listed.approvedBaseline.state, "UNAVAILABLE");

    // Missing metadata is rejected by the CLI.
    const bad = await runReviewCli(["approve", slug, first.discovery!.digest], db);
    assert.equal(bad.exitCode, 1);
    assert.equal(JSON.parse(bad.output).code, "INVALID_REVIEW_FIELD");
    const unknown = await runReviewCli(
      ["approve", slug, "f".repeat(64), "--actor", "a", "--reference", "r", "--reason", "x"],
      db,
    );
    assert.equal(JSON.parse(unknown.output).code, "OBSERVATION_NOT_FOUND");

    // Approve the exact digest.
    const approved = await runReviewCli(
      ["approve", slug, first.discovery!.digest, "--actor", "op", "--reference", "PR-1", "--reason", "initial review"],
      db,
    );
    assert.equal(approved.exitCode, 0);
    assert.equal(
      (await assessAgainstApprovedBaseline(db, slug, discovered(slug, toml("GKEYONE")))).assessment,
      "MATCHES_BASELINE",
    );

    // Sensitive change: observation retained, projection and status untouched.
    const before = await db.anchor.findUniqueOrThrow({ where: { slug } });
    const changedAnchor = { ...discovered(slug, toml("GKEYTWO")), isTransferCapable: true };
    const changed = await persistDiscoveredAnchor(changedAnchor);
    assert.equal(changed.discovery?.assessment, "CHANGED_UNREVIEWED");
    assert.ok(changed.discovery!.diff.some(({ field }) => field === "signingKey"));
    const after = await db.anchor.findUniqueOrThrow({ where: { slug } });
    assert.equal(after.isTransferCapable, before.isTransferCapable);
    assert.equal(after.status, before.status);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    assert.equal(await db.sep1DiscoveryObservation.count({ where: { anchorId: after.id } }), 2);
    assert.equal(
      (await assessAgainstApprovedBaseline(db, slug, changedAnchor)).assessment,
      "CHANGED_UNREVIEWED",
    );

    // Reject: baseline stays on the first approval.
    const rejected = await runReviewCli(
      ["reject", slug, changed.discovery!.digest, "--actor", "op", "--reference", "PR-2", "--reason", "unexpected key"],
      db,
    );
    assert.equal(rejected.exitCode, 0);
    assert.equal(
      (await assessAgainstApprovedBaseline(db, slug, changedAnchor)).assessment,
      "CHANGED_UNREVIEWED",
    );

    // Approve the change: it becomes the baseline; reviewed fields recorded.
    await runReviewCli(
      ["approve", slug, changed.discovery!.digest, "--actor", "op", "--reference", "PR-3", "--reason", "key rotation confirmed"],
      db,
    );
    assert.equal(
      (await assessAgainstApprovedBaseline(db, slug, changedAnchor)).assessment,
      "MATCHES_BASELINE",
    );
    const reviews = await db.sep1MetadataReview.findMany({
      where: { anchorId: after.id },
      orderBy: { reviewedAt: "asc" },
    });
    assert.deepEqual(reviews.map(({ decision }) => decision), ["APPROVED", "REJECTED", "APPROVED"]);
    assert.deepEqual(reviews[2]?.reviewedFields, ["signingKey"]);

    // A later matching sync promotes the projection again.
    const promoted = await persistDiscoveredAnchor(changedAnchor);
    assert.equal(promoted.discovery?.assessment, "MATCHES_BASELINE");
    assert.equal(promoted.isTransferCapable, true);

    // Append-only: history rows cannot be changed or removed.
    await assert.rejects(
      db.sep1DiscoveryObservation.updateMany({ where: { anchorId: after.id }, data: { tomlUrl: "https://x.example/" } }),
      /append-only/,
    );
    await assert.rejects(
      db.sep1MetadataReview.deleteMany({ where: { anchorId: after.id } }),
      /append-only/,
    );
  } finally {
    await db.$disconnect();
  }
});
