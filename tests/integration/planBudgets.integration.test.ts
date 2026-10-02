import assert from "node:assert/strict";
import test, { describe, before, after } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";


import { Prisma } from "@/app/generated/prisma/client";
import { latestObservationsQuery } from "@/lib/rates/latestRateRepository";
import { latestCorridorRatesQuery } from "@/lib/reputation/repository";

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

function findAllPlanNodes(node: Record<string, unknown>, nodeType: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  if (node["Node Type"] === nodeType) found.push(node);
  if (node.Plans) {
    for (const child of node.Plans as Record<string, unknown>[]) {
      found.push(...findAllPlanNodes(child, nodeType));
    }
  }
  return found;
}

function getScanRelations(node: Record<string, unknown>): Set<string> {
  const rels = new Set<string>();
  if (node["Relation Name"]) rels.add(node["Relation Name"] as string);
  if (node.Plans) {
    for (const child of node.Plans as Record<string, unknown>[]) {
      for (const rel of getScanRelations(child)) {
        rels.add(rel);
      }
    }
  }
  return rels;
}

/**
 * Fails the test and dumps the plan artifact if the budget is violated.
 */
function assertPlanBudget(
  testName: string,
  plan: Record<string, unknown>,
  budget: {
    maxHeapFetches?: number;
    maxRowsRemoved?: number;
    requireIndexScanOn?: string[];
    disallowSeqScanOn?: string[];
    disallowSortOn?: string[];
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

  if (budget.disallowSortOn) {
    const sortNodes = findAllPlanNodes(rootPlan, "Sort");
    for (const sortNode of sortNodes) {
      const relations = getScanRelations(sortNode);
      for (const table of budget.disallowSortOn) {
        if (relations.has(table) && relations.size === 1) {
          fail(`Explicit Sort node found for ${table} where ordered index scan is required.`);
        }
      }
    }
  }

  // Find all scan nodes
  const scans: Record<string, unknown>[] = [];
  const collectScans = (node: Record<string, unknown>) => {
    if (["Seq Scan", "Index Scan", "Index Only Scan", "Bitmap Heap Scan"].includes(node["Node Type"] as string)) {
      scans.push(node);
    }
    if (node.Plans) (node.Plans as Record<string, unknown>[]).forEach(collectScans);
  };
  collectScans(rootPlan);

  // Assert disallowed seq scans
  if (budget.disallowSeqScanOn) {
    for (const scan of scans) {
      if (scan["Node Type"] === "Seq Scan" && budget.disallowSeqScanOn.includes(scan["Relation Name"] as string)) {
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

if (process.env.RUN_DATABASE_INTEGRATION !== "1") {
  test.skip("Plan Budgets (Skipped: RUN_DATABASE_INTEGRATION not set)", () => {});
} else {
  describe("Plan Budgets", () => {
    let db: any;
    before(async () => {
      const mod = await import("@/lib/dbClient");
      db = mod.db;

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
        ${latestObservationsQuery(corridorId)}
      `;

      const result = await db.$queryRaw<Record<string, unknown>[]>(explainQuery);
      const plan = (result[0] as Record<string, unknown>)["QUERY PLAN"] as Record<string, unknown>[];
      const rootPlan = plan[0];
      
      assertPlanBudget("Latest Rate Observations", rootPlan, {
        maxHeapFetches: 100, maxRowsRemoved: 0,
        requireIndexScanOn: ["rate_snapshots"],
        disallowSeqScanOn: ["rate_snapshots"],
        disallowSortOn: ["rate_snapshots"],
      });
    });

    test("Plan Budget: Reputation Evidence Latest Rates Query (lib/reputation)", async () => {
      const anchorId = testAnchors[0].id;
      const explainQuery = Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${latestCorridorRatesQuery(anchorId)}
      `;

      const result = await db.$queryRaw<Record<string, unknown>[]>(explainQuery);
      const plan = (result[0] as Record<string, unknown>)["QUERY PLAN"] as Record<string, unknown>[];
      const rootPlan = plan[0];

      assertPlanBudget("Reputation Evidence Latest Rates", rootPlan, {
        maxHeapFetches: 100, maxRowsRemoved: 0,
        requireIndexScanOn: ["rate_snapshots"],
        disallowSeqScanOn: ["rate_snapshots"],
        disallowSortOn: ["rate_snapshots"],
      });
    });
  });
}
