import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalStringify,
  type ExportDependencies,
  exportEvidence,
  verifyExportPackage,
} from "@/lib/export";

const FIXED_NOW = new Date("2026-10-01T12:00:00.000Z");
const SELECTION = Object.freeze({
  timeRange: Object.freeze({
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
  }),
});

test("valid evidence package verifies offline", async () => {
  await withTempDir(async (dir) => {
    const result = await exportEvidence(
      dependencies(),
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, true);

    const verified = await verifyExportPackage(dir);
    assert.equal(verified.ok, true);
    if (verified.ok) {
      assert.equal(verified.manifest.version, "1.0");
      assert.equal(verified.manifest.members.length, 4);
    }
  });
});

test("modified and missing members fail verification", async () => {
  await withTempDir(async (dir) => {
    const result = await exportEvidence(
      dependencies(),
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, true);

    const ratePath = join(dir, "rate-snapshots.ndjson");
    await writeFile(
      ratePath,
      (await readFile(ratePath, "utf8")) + '{"tampered":true}\n',
      "utf8",
    );
    const tampered = await verifyExportPackage(dir);
    assert.equal(tampered.ok, false);
    assert.equal(!tampered.ok && tampered.code, "CORRUPTED_DATA");

    await unlink(join(dir, "transfer-outcomes.ndjson"));
    const missing = await verifyExportPackage(dir);
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.code, "MISSING_MEMBER");
  });
});

test("manifest provenance is bound into the root hash", async () => {
  await withTempDir(async (dir) => {
    const result = await exportEvidence(
      dependencies(),
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, true);

    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.provenance.exportedBy = "tampered-user";
    await writeFile(manifestPath, canonicalStringify(manifest) + "\n", "utf8");

    const verified = await verifyExportPackage(dir);
    assert.equal(verified.ok, false);
    assert.equal(!verified.ok && verified.code, "CORRUPTED_DATA");
  });
});

test("same bounded data and provenance produce deterministic package bytes", async () => {
  const first = await mkdtemp(join(tmpdir(), "stellarcore-export-a-"));
  const second = await mkdtemp(join(tmpdir(), "stellarcore-export-b-"));
  try {
    const one = await exportEvidence(
      dependencies(),
      SELECTION,
      first,
      "auditor",
      () => FIXED_NOW,
    );
    const two = await exportEvidence(
      dependencies(),
      SELECTION,
      second,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.deepEqual(one, two.ok && one.ok
      ? { ...two, outputPath: first }
      : two);

    for (const member of [
      "manifest.json",
      "registry.json",
      "rate-snapshots.ndjson",
      "transfer-outcomes.ndjson",
      "reputation-scores.ndjson",
    ]) {
      assert.equal(
        await readFile(join(first, member), "utf8"),
        await readFile(join(second, member), "utf8"),
      );
    }
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("large fixtures stream to NDJSON without an evidence aggregate", async () => {
  await withTempDir(async (dir) => {
    const rowCount = 5_000;
    const deps = dependencies(rowCount);
    const result = await exportEvidence(
      deps,
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const rates = result.manifest.members.find(
      ({ path }) => path === "rate-snapshots.ndjson",
    );
    assert.equal(rates?.recordCount, rowCount);

    const verified = await verifyExportPackage(dir);
    assert.equal(verified.ok, true);
  });
});

test("secret-shaped exported data is rejected before package completion", async () => {
  await withTempDir(async (dir) => {
    const deps = dependencies();
    const unsafe: ExportDependencies = Object.freeze({
      ...deps,
      async *streamRateSnapshots() {
        yield {
          id: "unsafe",
          anchorSlug: "anchor-a",
          corridorSlug: "usdc-us-ngn-ng",
          rate: "1",
          sourceAmount: "1",
          destinationAmount: "1",
          fee: "0",
          capturedAt: "2026-09-15T00:00:00.000Z",
          token: "Bearer should-never-export",
        } as never;
      },
    });

    const result = await exportEvidence(
      unsafe,
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, "SECRET_DETECTED");
  });
});

test("future package versions fail explicitly", async () => {
  await withTempDir(async (dir) => {
    const result = await exportEvidence(
      dependencies(),
      SELECTION,
      dir,
      "auditor",
      () => FIXED_NOW,
    );
    assert.equal(result.ok, true);

    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.version = "2.0";
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n", "utf8");

    const verified = await verifyExportPackage(dir);
    assert.equal(verified.ok, false);
    assert.equal(!verified.ok && verified.code, "UNSUPPORTED_VERSION");
  });
});

function dependencies(rateRows = 2): ExportDependencies {
  return Object.freeze({
    async queryRegistry() {
      return Object.freeze({
        anchors: Object.freeze([
          Object.freeze({
            slug: "anchor-a",
            name: "Anchor A",
            homeDomain: "anchor.example",
            status: "LIVE",
            seps: Object.freeze([1, 38]),
            isTransferCapable: true,
            createdAt: "2026-09-01T00:00:00.000Z",
            updatedAt: "2026-09-01T00:00:00.000Z",
          }),
        ]),
        corridors: Object.freeze([
          Object.freeze({
            slug: "usdc-us-ngn-ng",
            assetCodeFrom: "USDC",
            countryFrom: "US",
            assetCodeTo: "NGN",
            countryTo: "NG",
          }),
        ]),
        anchorCorridors: Object.freeze([
          Object.freeze({
            anchorSlug: "anchor-a",
            corridorSlug: "usdc-us-ngn-ng",
          }),
        ]),
      });
    },

    async *streamRateSnapshots() {
      for (let index = 0; index < rateRows; index += 1) {
        yield Object.freeze({
          id: index.toString().padStart(8, "0"),
          anchorSlug: "anchor-a",
          corridorSlug: "usdc-us-ngn-ng",
          rate: "1600",
          sourceAmount: "160000",
          destinationAmount: "100",
          fee: "0",
          capturedAt: "2026-09-15T00:00:00.000Z",
        });
      }
    },

    async *streamTransferOutcomes() {
      yield Object.freeze({
        id: "outcome-1",
        anchorSlug: "anchor-a",
        corridorSlug: "usdc-us-ngn-ng",
        status: "COMPLETED",
        fillRate: 1,
        settlementMs: 1_000,
        slippage: 0,
        recordedAt: "2026-09-15T00:00:00.000Z",
      });
    },

    async *streamReputationScores() {
      yield Object.freeze({
        id: "reputation-1",
        anchorSlug: "anchor-a",
        compositeScore: 90,
        scoreBand: "GREEN",
        fillRate7d: 1,
        fillRate30d: 1,
        fillRate90d: 1,
        settleP50Ms: 500,
        settleP95Ms: 1_500,
        slippageP50: 0,
        slippageP95: 0,
        sampleSize: 10,
        state: "OK",
        computedAt: "2026-09-15T00:00:00.000Z",
      });
    },
  });
}

async function withTempDir(
  callback: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "stellarcore-export-"));
  try {
    await callback(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
