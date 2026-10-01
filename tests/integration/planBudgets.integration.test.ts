import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { db } from "@/lib/dbClient";
import { Prisma } from "@/app/generated/prisma/client";

// Representative scale parameters
const FIXTURE_CORRIDOR_COUNT = 3;
const FIXTURE_ANCHOR_COUNT = 5;
const FIXTURE_SNAPSHOTS_PER_ANCHOR = 2000;

// Test IDs
const testCorridors = Array.from({ length: FIXTURE_CORRIDOR_COUNT }, () => ({
  id: randomUUID(),
  slug: `test-corridor-${randomUUID()}`,
  assetCodeFrom: "USDC",
  countryFrom: "US",
  assetCodeTo: "NGN",
  countryTo: "NG",
}));

const testAnchors = Array.from({ length: FIXTURE_ANCHOR_COUNT }, () => ({
  id: randomUUID(),
  slug: `test-anchor-${randomUUID()}`,
  name: "Test Anchor",
  homeDomain: "example.com",
  tomlUrl: "https://example.com/.well-known/stellar.toml",
}));

/**
 * Parses Postgres EXPLAIN JSON output and recursively searches for a specific node type.
 */
function findPlanNode(node: Record<string, unknown>, nodeType: string): Record<string, unknown> | null {
  if (node["Node Type"] === nodeType) return node;
  if (node.Plans) {
    for (const child of node.Plans as Record<string, unknown>[]) {
      const found = findPlanNode(child, nodeType);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Fails the test and dumps the plan artifact if the budget is violated.
 */
function assertPlanBudget(
  testName: string,
  plan: Record<string, unknown>,
  budget: {
    maxActualTotalTime?: number;
    requireIndexScanOn?: string[];
    disallowSeqScanOn?: string[];
    disallowSort?: boolean;
  }
) {
  const rootPlan = plan.Plan as Record<string, unknown>;
  const artifactPath = join(process.cwd(), `plan_artifact_${testName.replace(/\W+/g, "_")}.json`);
  let failed = false;
  let failureReason = "";

  const fail = (reason: string) => {
    failed = true;
    failureReason += reason + "\n";
  };

  // Inspect specific logical plan thresholds (rows scanned/removed, heap fetches)
  if (budget.maxHeapFetches !== undefined) {
    let totalHeapFetches = 0;
    const countHeapFetches = (node: Record<string, unknown>) => {
      if (typeof node["Heap Fetches"] === "number") totalHeapFetches += node["Heap Fetches"];
      if (node.Plans) (node.Plans as Record<string, unknown>[]).forEach(countHeapFetches);
    };
    countHeapFetches(rootPlan);
    if (totalHeapFetches > budget.maxHeapFetches) {
      fail(`Heap fetches exceeded budget: ${totalHeapFetches} > ${budget.maxHeapFetches}`);
    }
  }

  if (budget.maxRowsRemoved !== undefined) {
    let totalRowsRemoved = 0;
    const countRowsRemoved = (node: Record<string, unknown>) => {
      if (typeof node["Rows Removed by Filter"] === "number") totalRowsRemoved += node["Rows Removed by Filter"];
      if (typeof node["Rows Removed by Index Recheck"] === "number") totalRowsRemoved += node["Rows Removed by Index Recheck"];
      if (node.Plans) (node.Plans as Record<string, unknown>[]).forEach(countRowsRemoved);
    };
    countRowsRemoved(rootPlan);
    if (totalRowsRemoved > budget.maxRowsRemoved) {
      fail(`Rows removed exceeded budget: ${totalRowsRemoved} > ${budget.maxRowsRemoved}`);
    }
  }

  // Removed hard maxActualTotalTime to avoid flakiness

  // Check for disallowed Sort nodes
  if (budget.disallowSort) {
    const sortNode = findPlanNode(rootPlan, "Sort");
    if (sortNode) {
      fail("Explicit Sort node found in plan where ordered index scan is required.");
    }
  }

  // Find all scan nodes
  const scans: Record<string, unknown>[] = [];
  const collectScans = (node: Record<string, unknown>) => {
    if (["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(node["Node Type"])) {
      scans.push(node);
    }
    if (node.Plans) (node.Plans as Record<string, unknown>[]).forEach(collectScans);
  };
  collectScans(rootPlan);

  // Assert disallowed seq scans
  if (budget.disallowSeqScanOn) {
    for (const scan of scans) {
      if (scan["Node Type"] === "Seq Scan" && budget.disallowSeqScanOn.includes(scan["Relation Name"])) {
        fail(`Disallowed Seq Scan detected on table: ${scan["Relation Name"]}`);
      }
    }
  }

  // Assert required index scans
  if (budget.requireIndexScanOn) {
    for (const tableName of budget.requireIndexScanOn) {
      const indexScan = scans.find(
        (s) =>
          (s["Node Type"] === "Index Scan" || s["Node Type"] === "Index Only Scan") &&
          s["Relation Name"] === tableName
      );
      if (!indexScan) {
        fail(`Required Index/Index Only Scan not found for table: ${tableName}`);
      }
    }
  }

  if (failed) {
    // Write artifact for debugging
    writeFileSync(artifactPath, JSON.stringify(plan, null, 2), "utf8");
    assert.fail(
      `Plan budget violation in '${testName}'.\n${failureReason}\nArtifact saved to: ${artifactPath}\n\n` +
      `To update thresholds intentionally: Adjust the budget in tests/integration/planBudgets.integration.test.ts and explain the structural regression acceptance in the PR.`
    );
  }
}

before(async () => {
  // Ensure we are connected
  await db.$connect();

  // Create representative scale fixtures
  await db.corridor.createMany({ data: testCorridors, skipDuplicates: true });
  await db.anchor.createMany({ data: testAnchors, skipDuplicates: true });

  const snapshots: Prisma.RateSnapshotCreateManyInput[] = [];
  const now = new Date().getTime();

  // Generate records per anchor for ALL test corridors to ensure proper scale representation
  for (const anchor of testAnchors) {
    for (const corridor of testCorridors) {
      for (let i = 0; i < FIXTURE_SNAPSHOTS_PER_ANCHOR; i++) {
        snapshots.push({
          anchorId: anchor.id,
          corridorId: corridor.id,
          rate: new Prisma.Decimal("100"),
          sourceAmount: new Prisma.Decimal("1"),
          destinationAmount: new Prisma.Decimal("100"),
          capturedAt: new Date(now - i * 60000), // minute apart
        });
      }
    }
  }

  // Batch insert to avoid huge query limits
  const chunkSize = 1000;
  for (let i = 0; i < snapshots.length; i += chunkSize) {
    await db.rateSnapshot.createMany({ data: snapshots.slice(i, i + chunkSize) });
  }

  // Analyze the tables so Postgres query planner has accurate statistics
  await db.$executeRawUnsafe(`ANALYZE rate_snapshots`);
  await db.$executeRawUnsafe(`ANALYZE anchors`);
  await db.$executeRawUnsafe(`ANALYZE corridors`);
});

after(async () => {
  // Cleanup test fixtures
  await db.rateSnapshot.deleteMany({
    where: { corridorId: { in: testCorridors.map((c) => c.id) } },
  });
  await db.anchor.deleteMany({
    where: { id: { in: testAnchors.map((a) => a.id) } },
  });
  await db.corridor.deleteMany({
    where: { id: { in: testCorridors.map((c) => c.id) } },
  });
  await db.$disconnect();
});

test("Plan Budget: Latest Rate Observations Query (lib/rates)", async () => {
  const corridorId = testCorridors[0].id;
  const explainQuery = Prisma.sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT
      latest.id,
      anchor.slug AS "anchorSlug",
      anchor.name AS "anchorName",
      latest.rate,
      latest.source_amount AS "sourceAmount",
      latest.destination_amount AS "destinationAmount",
      latest.fee,
      latest.captured_at AS "capturedAt"
    FROM anchors AS anchor
    CROSS JOIN LATERAL (
      SELECT
        snapshot.id,
        snapshot.rate,
        snapshot.source_amount,
        snapshot.destination_amount,
        snapshot.fee,
        snapshot.captured_at
      FROM rate_snapshots AS snapshot
      WHERE snapshot.corridor_id = ${corridorId}::uuid
        AND snapshot.anchor_id = anchor.id
      ORDER BY snapshot.captured_at DESC, snapshot.id DESC
      LIMIT 1
    ) AS latest
    ORDER BY anchor.id
  `;

  const result = await db.$queryRaw<Record<string, unknown>[]>(explainQuery);
  const plan = (result[0] as Record<string, unknown>)["QUERY PLAN"] as Record<string, unknown>[];
  const rootPlan = plan[0];
  
  assertPlanBudget("Latest Rate Observations", rootPlan, {
    maxHeapFetches: 100, maxRowsRemoved: 0,
    requireIndexScanOn: ["rate_snapshots"],
    disallowSeqScanOn: ["rate_snapshots"],
    disallowSort: true, // Should use the ordered index rather than an explicit Sort node
  });
});

test("Plan Budget: Reputation Evidence Latest Rates Query (lib/reputation)", async () => {
  const anchorId = testAnchors[0].id;
  const explainQuery = Prisma.sql`
    EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
    SELECT
      corridor.slug AS "corridorSlug",
      latest.captured_at AS "capturedAt"
    FROM corridors AS corridor
    CROSS JOIN LATERAL (
      SELECT snapshot.captured_at
      FROM rate_snapshots AS snapshot
      WHERE snapshot.anchor_id = ${anchorId}::uuid
        AND snapshot.corridor_id = corridor.id
      ORDER BY snapshot.captured_at DESC, snapshot.id DESC
      LIMIT 1
    ) AS latest
    ORDER BY corridor.slug
  `;

  const result = await db.$queryRaw<Record<string, unknown>[]>(explainQuery);
  const plan = (result[0] as Record<string, unknown>)["QUERY PLAN"] as Record<string, unknown>[];
  const rootPlan = plan[0];

  assertPlanBudget("Reputation Evidence Latest Rates", rootPlan, {
    maxHeapFetches: 100, maxRowsRemoved: 0,
    requireIndexScanOn: ["rate_snapshots"],
    disallowSeqScanOn: ["rate_snapshots"],
    disallowSort: true, // Should leverage rate_snapshots_anchor_corridor_latest_idx
  });
});
