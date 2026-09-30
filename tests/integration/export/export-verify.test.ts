import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@/lib/dbClient";

import { exportEvidence, verifyExportPackage, formatVerificationResult, loadExportPackage } from "@/lib/export";
import { createPrismaExportDependencies } from "@/lib/export/export";

const TEST_ANCHOR_SLUG = "export-test-anchor";
const TEST_CORRIDOR_SLUG = "export-test-corridor";
const TEST_OUTPUT_DIR = "/tmp/stellarcore-export-test";

describe("Export/Verify integration tests", () => {
  before(async () => {
    await cleanupTestData();
    await setupTestData();
    await mkdir(TEST_OUTPUT_DIR, { recursive: true });
  });

  after(async () => {
    await cleanupTestData();
    await rm(TEST_OUTPUT_DIR, { recursive: true, force: true });
    await db.$disconnect();
  });

  it("exports and verifies a valid package", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, TEST_OUTPUT_DIR, "test-user");

    assert.ok(result.ok, `Export failed: ${result.message}`);
    assert.equal(result.outputPath, TEST_OUTPUT_DIR);
    assert.ok(result.manifest.rootSha256.length === 64);
    assert.ok(result.manifest.registry.recordCount > 0);
    assert.ok(result.manifest.evidence.recordCount >= 0);

    const verification = await verifyExportPackage(TEST_OUTPUT_DIR);
    assert.ok(verification.ok, `Verification failed: ${verification.message}`);
    assert.equal(verification.manifest.rootSha256, result.manifest.rootSha256);
  });

  it("verification fails when registry file is modified", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "tamper-registry"));
    assert.ok(result.ok);

    const fs = await import("node:fs/promises");
    const registryPath = join(TEST_OUTPUT_DIR, "tamper-registry", "registry.json");
    const registryContent = await fs.readFile(registryPath, "utf-8");
    const registry = JSON.parse(registryContent);
    registry.anchors.push({
      slug: "tampered",
      name: "Tampered",
      homeDomain: "tampered.com",
      status: "LIVE",
      seps: [],
      isTransferCapable: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));

    const verification = await verifyExportPackage(join(TEST_OUTPUT_DIR, "tamper-registry"));
    assert.ok(!verification.ok);
    assert.equal(verification.code, "CORRUPTED_DATA");
  });

  it("verification fails when evidence file is modified", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "tamper-evidence"));
    assert.ok(result.ok);

    const fs = await import("node:fs/promises");
    const evidencePath = join(TEST_OUTPUT_DIR, "tamper-evidence", "evidence.json");
    const evidenceContent = await fs.readFile(evidencePath, "utf-8");
    const evidence = JSON.parse(evidenceContent);
    evidence.rateSnapshots.push({
      id: "tampered",
      anchorSlug: "moneygram",
      corridorSlug: "usdc-us-usd-us",
      rate: "999.0",
      sourceAmount: "100",
      destinationAmount: "99900",
      fee: "0",
      capturedAt: "2026-01-15T12:00:00.000Z",
    });
    await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2));

    const verification = await verifyExportPackage(join(TEST_OUTPUT_DIR, "tamper-evidence"));
    assert.ok(!verification.ok);
    assert.equal(verification.code, "CORRUPTED_DATA");
  });

  it("verification fails when manifest is modified", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "tamper-manifest"));
    assert.ok(result.ok);

    const fs = await import("node:fs/promises");
    const manifestPath = join(TEST_OUTPUT_DIR, "tamper-manifest", "manifest.json");
    const manifestContent = await fs.readFile(manifestPath, "utf-8");
    const manifest = JSON.parse(manifestContent);
    manifest.rootSha256 = "f".repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const verification = await verifyExportPackage(join(TEST_OUTPUT_DIR, "tamper-manifest"));
    assert.ok(!verification.ok);
    assert.equal(verification.code, "MANIFEST_MISMATCH");
  });

  it("verification fails when registry file is missing", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "missing-registry"));
    assert.ok(result.ok);

    const fs = await import("node:fs/promises");
    await fs.rm(join(TEST_OUTPUT_DIR, "missing-registry", "registry.json"));

    const verification = await verifyExportPackage(join(TEST_OUTPUT_DIR, "missing-registry"));
    assert.ok(!verification.ok);
    assert.equal(verification.code, "MISSING_MEMBER");
  });

  it("export filters by anchor slug", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
      anchorSlugs: [TEST_ANCHOR_SLUG],
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "filter-anchor"));
    assert.ok(result.ok);

    const pkg = await loadExportPackage(join(TEST_OUTPUT_DIR, "filter-anchor"));
    for (const anchor of pkg.registry.anchors) {
      assert.equal(anchor.slug, TEST_ANCHOR_SLUG);
    }
    for (const snapshot of pkg.evidence.rateSnapshots) {
      assert.equal(snapshot.anchorSlug, TEST_ANCHOR_SLUG);
    }
  });

  it("export filters by corridor slug", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
      corridorSlugs: [TEST_CORRIDOR_SLUG],
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "filter-corridor"));
    assert.ok(result.ok);

    const pkg = await loadExportPackage(join(TEST_OUTPUT_DIR, "filter-corridor"));
    for (const corridor of pkg.registry.corridors) {
      assert.equal(corridor.slug, TEST_CORRIDOR_SLUG);
    }
    for (const snapshot of pkg.evidence.rateSnapshots) {
      assert.equal(snapshot.corridorSlug, TEST_CORRIDOR_SLUG);
    }
  });

  it("export filters by time range", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-30T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "filter-time"));
    assert.ok(result.ok);

    const pkg = await loadExportPackage(join(TEST_OUTPUT_DIR, "filter-time"));
    for (const snapshot of pkg.evidence.rateSnapshots) {
      const capturedAt = new Date(snapshot.capturedAt);
      assert.ok(capturedAt >= new Date("2026-06-01T00:00:00.000Z"));
      assert.ok(capturedAt <= new Date("2026-06-30T23:59:59.000Z"));
    }
  });

  it("export contains no secrets", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "no-secrets"));
    assert.ok(result.ok);

    const pkg = await loadExportPackage(join(TEST_OUTPUT_DIR, "no-secrets"));
    const json = JSON.stringify(pkg);
    assert.ok(!json.includes("postgresql://"));
    assert.ok(!json.includes("password"));
    assert.ok(!json.includes("secret"));
    assert.ok(!json.includes("token"));
  });

  it("formatVerificationResult produces readable output", async () => {
    const deps = await createPrismaExportDependencies();
    const selection = {
      timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-12-31T23:59:59.000Z" },
    };

    const result = await exportEvidence(deps, selection, join(TEST_OUTPUT_DIR, "format"));
    assert.ok(result.ok);

    const verification = await verifyExportPackage(join(TEST_OUTPUT_DIR, "format"));
    assert.ok(verification.ok);

    const formatted = formatVerificationResult(verification);
    assert.ok(formatted.includes("✓ Verification successful"));
    assert.ok(formatted.includes("Root SHA256:"));
    assert.ok(formatted.includes("Registry:"));
    assert.ok(formatted.includes("Evidence:"));
  });
});

async function setupTestData() {
  await db.anchorCorridor.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.rateSnapshot.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.transferOutcome.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.reputationScore.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.anchor.deleteMany({ where: { slug: TEST_ANCHOR_SLUG } });
  await db.corridor.deleteMany({ where: { slug: TEST_CORRIDOR_SLUG } });

  const anchor = await db.anchor.create({
    data: {
      slug: TEST_ANCHOR_SLUG,
      name: "Export Test Anchor",
      homeDomain: "example.com",
      tomlUrl: "https://example.com/.well-known/stellar.toml",
      seps: [1, 6, 10, 24, 31, 38],
      isTransferCapable: true,
      status: "LIVE",
    },
  });

  const corridor = await db.corridor.create({
    data: {
      slug: TEST_CORRIDOR_SLUG,
      assetCodeFrom: "USDC",
      countryFrom: "US",
      assetCodeTo: "USD",
      countryTo: "US",
    },
  });

  await db.anchorCorridor.create({
    data: { anchorId: anchor.id, corridorId: corridor.id },
  });

  await db.rateSnapshot.create({
    data: {
      anchorId: anchor.id,
      corridorId: corridor.id,
      rate: 1.0,
      sourceAmount: 100,
      destinationAmount: 100,
      fee: 0,
      capturedAt: new Date("2026-06-15T12:00:00.000Z"),
    },
  });

  await db.transferOutcome.create({
    data: {
      anchorId: anchor.id,
      corridorId: corridor.id,
      status: "COMPLETED",
      fillRate: 1.0,
      settlementMs: 1000,
      slippage: 0.0,
      recordedAt: new Date("2026-06-15T12:00:00.000Z"),
    },
  });

  await db.reputationScore.create({
    data: {
      anchorId: anchor.id,
      compositeScore: 90,
      scoreBand: "GREEN",
      fillRate7d: 0.95,
      fillRate30d: 0.93,
      fillRate90d: 0.91,
      settleP50Ms: 500,
      settleP95Ms: 2000,
      slippageP50: 0.01,
      slippageP95: 0.05,
      sampleSize: 100,
      state: "OK",
      computedAt: new Date("2026-06-15T12:00:00.000Z"),
    },
  });
}

async function cleanupTestData() {
  await db.anchorCorridor.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.rateSnapshot.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.transferOutcome.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.reputationScore.deleteMany({ where: { anchor: { slug: TEST_ANCHOR_SLUG } } });
  await db.anchor.deleteMany({ where: { slug: TEST_ANCHOR_SLUG } });
  await db.corridor.deleteMany({ where: { slug: TEST_CORRIDOR_SLUG } });
}