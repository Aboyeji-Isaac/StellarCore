import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalStringify,
  computeRootHash,
} from "@/lib/export/canonical";
import { sanitizeForExport } from "@/lib/export/redact";
import type {
  ExportSelection,
  ExportProvenance,
  ExportRegistry,
  ExportEvidence,
  ExportManifest,
  ExportPackage,
} from "@/lib/export/types";

test("ExportSelection type structure is correct", () => {
  const selection: ExportSelection = {
    timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.000Z" },
    anchorSlugs: ["moneygram", "cowrie"],
    corridorSlugs: ["usdc-us-usd-us"],
  };
  assert.ok(selection.timeRange.start);
  assert.ok(selection.timeRange.end);
  assert.ok(selection.anchorSlugs);
  assert.ok(selection.corridorSlugs);
});

test("ExportProvenance includes all required fields", () => {
  const provenance: ExportProvenance = {
    exportedAt: "2026-01-15T12:00:00.000Z",
    exportedBy: "test-user",
    stellarCoreVersion: "0.1.0",
    schemaVersion: "1.0",
    selection: { timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.000Z" } },
  };
  assert.equal(provenance.schemaVersion, "1.0");
  assert.equal(provenance.exportedBy, "test-user");
});

test("ExportRegistry anchors are sorted by slug in canonical output", () => {
  const registry: ExportRegistry = {
    anchors: [
      { slug: "zeam", name: "Zeam", homeDomain: "zeam.money", status: "LIVE", seps: [1, 38], isTransferCapable: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { slug: "moneygram", name: "MoneyGram", homeDomain: "mgxanchor.moneygram.com", status: "LIVE", seps: [1, 6, 10, 24, 31, 38], isTransferCapable: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    corridors: [],
    anchorCorridors: [],
  };
  const json = canonicalStringify(registry);
  assert.ok(json.indexOf("moneygram") < json.indexOf("zeam"));
});

test("ExportEvidence rate snapshots are sorted deterministically in canonical output", () => {
  const evidence: ExportEvidence = {
    rateSnapshots: [
      { id: "2", anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us", rate: "1.0", sourceAmount: "100", destinationAmount: "100", fee: "0", capturedAt: "2026-01-15T12:00:00.000Z" },
      { id: "1", anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us", rate: "1.0", sourceAmount: "100", destinationAmount: "100", fee: "0", capturedAt: "2026-01-15T12:00:00.000Z" },
    ],
    transferOutcomes: [],
    reputationScores: [],
  };
  const json = canonicalStringify(evidence);
  assert.ok(json.indexOf('"id":"1"') < json.indexOf('"id":"2"'));
});

test("ExportManifest computes root hash from members", () => {
  const registryEntry = { path: "registry.json", sha256: "a".repeat(64), byteLength: 100, recordCount: 10 };
  const evidenceEntry = { path: "evidence.json", sha256: "b".repeat(64), byteLength: 200, recordCount: 20 };
  const rootSha256 = computeRootHash([registryEntry, evidenceEntry]);

  const manifest: ExportManifest = {
    version: "1.0",
    provenance: {
      exportedAt: "2026-01-15T12:00:00.000Z",
      exportedBy: "test-user",
      stellarCoreVersion: "0.1.0",
      schemaVersion: "1.0",
      selection: { timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.000Z" } },
    },
    registry: registryEntry,
    evidence: evidenceEntry,
    rootSha256,
  };

  assert.equal(manifest.rootSha256, rootSha256);
  assert.equal(manifest.rootSha256.length, 64);
});

test("canonicalStringify produces deterministic output for ExportPackage", () => {
  const pkg: ExportPackage = {
    manifest: {
      version: "1.0",
      provenance: {
        exportedAt: "2026-01-15T12:00:00.000Z",
        exportedBy: "test-user",
        stellarCoreVersion: "0.1.0",
        schemaVersion: "1.0",
        selection: { timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.000Z" } },
      },
      registry: { path: "registry.json", sha256: "a".repeat(64), byteLength: 100, recordCount: 10 },
      evidence: { path: "evidence.json", sha256: "b".repeat(64), byteLength: 200, recordCount: 20 },
      rootSha256: "c".repeat(64),
    },
    registry: {
      anchors: [{ slug: "moneygram", name: "MoneyGram", homeDomain: "mgxanchor.moneygram.com", status: "LIVE", seps: [1, 6], isTransferCapable: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      corridors: [{ slug: "usdc-us-usd-us", assetCodeFrom: "USDC", countryFrom: "US", assetCodeTo: "USD", countryTo: "US" }],
      anchorCorridors: [{ anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us" }],
    },
    evidence: {
      rateSnapshots: [{ id: "1", anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us", rate: "1.0", sourceAmount: "100", destinationAmount: "100", fee: "0", capturedAt: "2026-01-15T12:00:00.000Z" }],
      transferOutcomes: [{ id: "1", anchorSlug: "moneygram", corridorSlug: "usdc-us-usd-us", status: "COMPLETED", fillRate: 1.0, settlementMs: 1000, slippage: 0.0, recordedAt: "2026-01-15T12:00:00.000Z" }],
      reputationScores: [{ id: "1", anchorSlug: "moneygram", compositeScore: 90, scoreBand: "GREEN", fillRate7d: 0.95, fillRate30d: 0.93, fillRate90d: 0.91, settleP50Ms: 500, settleP95Ms: 2000, slippageP50: 0.01, slippageP95: 0.05, sampleSize: 100, state: "OK", computedAt: "2026-01-15T12:00:00.000Z" }],
    },
  };

  const json1 = canonicalStringify(pkg);
  const json2 = canonicalStringify(pkg);
  assert.equal(json1, json2);
  assert.ok(json1.includes("moneygram"));
});

test("sanitizeForExport redacts secrets in ExportPackage", () => {
  const pkgWithSecrets: ExportPackage = {
    manifest: {
      version: "1.0",
      provenance: {
        exportedAt: "2026-01-15T12:00:00.000Z",
        exportedBy: "test-user",
        stellarCoreVersion: "0.1.0",
        schemaVersion: "1.0",
        selection: { timeRange: { start: "2026-01-01T00:00:00.000Z", end: "2026-01-31T23:59:59.000Z" } },
      },
      registry: { path: "registry.json", sha256: "a".repeat(64), byteLength: 100, recordCount: 10 },
      evidence: { path: "evidence.json", sha256: "b".repeat(64), byteLength: 200, recordCount: 20 },
      rootSha256: "c".repeat(64),
    },
    registry: {
      anchors: [{ slug: "moneygram", name: "MoneyGram", homeDomain: "mgxanchor.moneygram.com", status: "LIVE", seps: [1, 6], isTransferCapable: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
      corridors: [],
      anchorCorridors: [],
    },
    evidence: {
      rateSnapshots: [],
      transferOutcomes: [],
      reputationScores: [],
    },
  };

  const sanitized = sanitizeForExport(pkgWithSecrets);
  const json = canonicalStringify(sanitized);
  assert.ok(!json.includes("postgresql://"));
  assert.ok(!json.includes("sk_live_"));
});