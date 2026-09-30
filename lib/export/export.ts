import { Prisma } from "@/app/generated/prisma/client";
import { createWriteStream } from "node:fs";

import type {
  ExportSelection,
  ExportProvenance,
  ExportAnchor,
  ExportCorridor,
  ExportAnchorCorridor,
  ExportRateSnapshot,
  ExportTransferOutcome,
  ExportReputationScore,
  ExportRegistry,
  ExportEvidence,
  ExportManifest,
  ExportManifestEntry,
  ExportPackage,
  ExportResult,
  ExportErrorCode,
} from "@/lib/export/types";
import {
  canonicalStringify,
  computeSha256FromString,
  computeRootHash,
  serializeToBuffer,
} from "@/lib/export/canonical";
import { sanitizeForExport, assertNoSecrets } from "@/lib/export/redact";

const STELLARCORE_VERSION = "0.1.0";

export interface ExportDependencies {
  queryAnchors: (selection: ExportSelection) => Promise<ExportAnchor[]>;
  queryCorridors: (selection: ExportSelection) => Promise<ExportCorridor[]>;
  queryAnchorCorridors: (selection: ExportSelection) => Promise<ExportAnchorCorridor[]>;
  queryRateSnapshots: (selection: ExportSelection) => AsyncIterable<ExportRateSnapshot>;
  queryTransferOutcomes: (selection: ExportSelection) => AsyncIterable<ExportTransferOutcome>;
  queryReputationScores: (selection: ExportSelection) => Promise<ExportReputationScore[]>;
}

function validateSelection(selection: ExportSelection): void {
  const start = new Date(selection.timeRange.start);
  const end = new Date(selection.timeRange.end);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error("Invalid time range: start and end must be valid ISO 8601 dates");
  }
  if (start >= end) {
    throw new Error("Invalid time range: start must be before end");
  }
  if (selection.anchorSlugs !== undefined) {
    for (const slug of selection.anchorSlugs) {
      if (!slug || slug.trim() === "") {
        throw new Error("Invalid anchor slug: empty string");
      }
    }
  }
  if (selection.corridorSlugs !== undefined) {
    for (const slug of selection.corridorSlugs) {
      if (!slug || slug.trim() === "") {
        throw new Error("Invalid corridor slug: empty string");
      }
    }
  }
}

async function collectRegistry(
  deps: ExportDependencies,
  selection: ExportSelection,
): Promise<ExportRegistry> {
  const [anchors, corridors, anchorCorridors] = await Promise.all([
    deps.queryAnchors(selection),
    deps.queryCorridors(selection),
    deps.queryAnchorCorridors(selection),
  ]);

  return Object.freeze({
    anchors: Object.freeze(anchors.sort((a, b) => a.slug.localeCompare(b.slug))),
    corridors: Object.freeze(corridors.sort((a, b) => a.slug.localeCompare(b.slug))),
    anchorCorridors: Object.freeze(
      anchorCorridors.sort((a, b) =>
        a.anchorSlug.localeCompare(b.anchorSlug) || a.corridorSlug.localeCompare(b.corridorSlug),
      ),
    ),
  });
}

async function collectEvidence(
  deps: ExportDependencies,
  selection: ExportSelection,
): Promise<ExportEvidence> {
  const [reputationScores] = await Promise.all([
    deps.queryReputationScores(selection),
  ]);

  const rateSnapshots: ExportRateSnapshot[] = [];
  for await (const snapshot of deps.queryRateSnapshots(selection)) {
    rateSnapshots.push(snapshot);
  }

  const transferOutcomes: ExportTransferOutcome[] = [];
  for await (const outcome of deps.queryTransferOutcomes(selection)) {
    transferOutcomes.push(outcome);
  }

  return Object.freeze({
    rateSnapshots: Object.freeze(
      rateSnapshots.sort((a, b) =>
        a.anchorSlug.localeCompare(b.anchorSlug) ||
        a.corridorSlug.localeCompare(b.corridorSlug) ||
        a.capturedAt.localeCompare(b.capturedAt) ||
        a.id.localeCompare(b.id),
      ),
    ),
    transferOutcomes: Object.freeze(
      transferOutcomes.sort((a, b) =>
        a.anchorSlug.localeCompare(b.anchorSlug) ||
        a.corridorSlug.localeCompare(b.corridorSlug) ||
        a.recordedAt.localeCompare(b.recordedAt) ||
        a.id.localeCompare(b.id),
      ),
    ),
    reputationScores: Object.freeze(
      reputationScores.sort((a, b) => a.anchorSlug.localeCompare(b.anchorSlug)),
    ),
  });
}

async function writeJsonFile<T>(
  data: T,
  filePath: string,
  stringify: (value: T) => string = canonicalStringify,
): Promise<ExportManifestEntry> {
  const json = stringify(data);
  const sanitized = sanitizeForExport(json);
  assertNoSecrets(sanitized);

  const buffer = serializeToBuffer(sanitized);
  const sha256 = computeSha256FromString(sanitized);

  const stream = createWriteStream(filePath, { flags: "w" });
  stream.write(buffer);
  await new Promise<void>((resolve, reject) => {
    stream.end((err) => (err ? reject(err) : resolve()));
  });

  return Object.freeze({
    path: filePath,
    sha256,
    byteLength: buffer.length,
    recordCount: Array.isArray(data) ? data.length : 1,
  });
}

export async function createExportPackage(
  deps: ExportDependencies,
  selection: ExportSelection,
  exportedBy: string,
): Promise<ExportPackage> {
  validateSelection(selection);

  const exportedAt = new Date().toISOString();

  const provenance: ExportProvenance = Object.freeze({
    exportedAt,
    exportedBy,
    stellarCoreVersion: STELLARCORE_VERSION,
    schemaVersion: "1.0",
    selection: Object.freeze({ ...selection }),
  });

  const registry = await collectRegistry(deps, selection);
  const evidence = await collectEvidence(deps, selection);

  const manifest: ExportManifest = Object.freeze({
    version: "1.0",
    provenance,
    registry: { path: "", sha256: "", byteLength: 0, recordCount: 0 },
    evidence: { path: "", sha256: "", byteLength: 0, recordCount: 0 },
    rootSha256: "",
  });

  return Object.freeze({
    manifest,
    registry,
    evidence,
  });
}

export async function writeExportPackage(
  pkg: ExportPackage,
  outputDir: string,
): Promise<ExportManifest> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(outputDir, { recursive: true });

  const registryPath = `${outputDir}/registry.json`;
  const evidencePath = `${outputDir}/evidence.json`;
  const manifestPath = `${outputDir}/manifest.json`;

  const registryEntry = await writeJsonFile(pkg.registry, registryPath);
  const evidenceEntry = await writeJsonFile(pkg.evidence, evidencePath);

  const rootSha256 = computeRootHash([registryEntry, evidenceEntry]);

  const manifest: ExportManifest = Object.freeze({
    version: "1.0",
    provenance: pkg.manifest.provenance,
    registry: registryEntry,
    evidence: evidenceEntry,
    rootSha256,
  });

  await writeJsonFile(manifest, manifestPath);

  return manifest;
}

export async function exportEvidence(
  deps: ExportDependencies,
  selection: ExportSelection,
  outputDir: string,
  exportedBy: string,
): Promise<ExportResult> {
  try {
    validateSelection(selection);

    const pkg = await createExportPackage(deps, selection, exportedBy);
    const manifest = await writeExportPackage(pkg, outputDir);

    return Object.freeze({
      ok: true,
      manifest,
      outputPath: outputDir,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let code: ExportErrorCode = "IO_ERROR";
    if (message.includes("Invalid selection") || message.includes("Invalid time range") || message.includes("Invalid anchor slug") || message.includes("Invalid corridor slug")) {
      code = "INVALID_SELECTION";
    } else if (message.includes("database") || message.includes("Prisma") || message.includes("query")) {
      code = "DATABASE_ERROR";
    } else if (message.includes("serializ") || message.includes("stringify") || message.includes("JSON")) {
      code = "SERIALIZATION_ERROR";
    } else if (message.includes("manifest")) {
      code = "MANIFEST_GENERATION_ERROR";
    } else if (message.includes("secret") || message.includes("REDACTED")) {
      code = "SECRET_REDACTION_ERROR";
    }

    return Object.freeze({
      ok: false,
      code,
      message,
    });
  }
}

export async function* createPrismaExportDependencies(): Promise<ExportDependencies> {
  const { db } = await import("@/lib/dbClient");

  return Object.freeze({
    async queryAnchors(selection) {
      const where: Prisma.AnchorWhereInput = {};
      if (selection.anchorSlugs?.length) {
        where.slug = { in: [...selection.anchorSlugs] };
      }
      const anchors = await db.anchor.findMany({
        where,
        orderBy: { slug: "asc" },
        select: {
          slug: true,
          name: true,
          homeDomain: true,
          status: true,
          seps: true,
          isTransferCapable: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return anchors.map((a) => ({
        slug: a.slug,
        name: a.name,
        homeDomain: a.homeDomain,
        status: a.status,
        seps: [...a.seps],
        isTransferCapable: a.isTransferCapable,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
      }));
    },

    async queryCorridors(selection) {
      const where: Prisma.CorridorWhereInput = {};
      if (selection.corridorSlugs?.length) {
        where.slug = { in: [...selection.corridorSlugs] };
      }
      const corridors = await db.corridor.findMany({
        where,
        orderBy: { slug: "asc" },
        select: {
          slug: true,
          assetCodeFrom: true,
          countryFrom: true,
          assetCodeTo: true,
          countryTo: true,
        },
      });
      return corridors.map((c) => ({
        slug: c.slug,
        assetCodeFrom: c.assetCodeFrom,
        countryFrom: c.countryFrom,
        assetCodeTo: c.assetCodeTo,
        countryTo: c.countryTo,
      }));
    },

    async queryAnchorCorridors(selection) {
      const where: Prisma.AnchorCorridorWhereInput = {};
      if (selection.anchorSlugs?.length) {
        where.anchorId = { in: [] };
        const anchorIds = await db.anchor.findMany({
          where: { slug: { in: [...selection.anchorSlugs] } },
          select: { id: true },
        });
        if (anchorIds.length > 0) {
          where.anchorId = { in: anchorIds.map((a) => a.id) };
        }
      }
      if (selection.corridorSlugs?.length) {
        const corridorIds = await db.corridor.findMany({
          where: { slug: { in: [...selection.corridorSlugs] } },
          select: { id: true },
        });
        if (corridorIds.length > 0) {
          where.corridorId = { in: corridorIds.map((c) => c.id) };
        }
      }
      const associations = await db.anchorCorridor.findMany({
        where,
        orderBy: [{ anchorId: "asc" }, { corridorId: "asc" }],
        select: {
          anchor: { select: { slug: true } },
          corridor: { select: { slug: true } },
        },
      });
      return associations.map((a) => ({
        anchorSlug: a.anchor.slug,
        corridorSlug: a.corridor.slug,
      }));
    },

    async *queryRateSnapshots(selection) {
      const where: Prisma.RateSnapshotWhereInput = {
        capturedAt: {
          gte: new Date(selection.timeRange.start),
          lte: new Date(selection.timeRange.end),
        },
      };
      if (selection.anchorSlugs?.length) {
        const anchorIds = await db.anchor.findMany({
          where: { slug: { in: [...selection.anchorSlugs] } },
          select: { id: true },
        });
        if (anchorIds.length > 0) {
          where.anchorId = { in: anchorIds.map((a) => a.id) };
        }
      }
      if (selection.corridorSlugs?.length) {
        const corridorIds = await db.corridor.findMany({
          where: { slug: { in: [...selection.corridorSlugs] } },
          select: { id: true },
        });
        if (corridorIds.length > 0) {
          where.corridorId = { in: corridorIds.map((c) => c.id) };
        }
      }

      const snapshots = await db.rateSnapshot.findMany({
        where,
        orderBy: [{ anchorId: "asc" }, { corridorId: "asc" }, { capturedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          anchor: { select: { slug: true } },
          corridor: { select: { slug: true } },
          rate: true,
          sourceAmount: true,
          destinationAmount: true,
          fee: true,
          capturedAt: true,
        },
      });

      for (const s of snapshots) {
        yield {
          id: s.id,
          anchorSlug: s.anchor.slug,
          corridorSlug: s.corridor.slug,
          rate: s.rate.toString(),
          sourceAmount: s.sourceAmount.toString(),
          destinationAmount: s.destinationAmount.toString(),
          fee: s.fee.toString(),
          capturedAt: s.capturedAt.toISOString(),
        };
      }
    },

    async *queryTransferOutcomes(selection) {
      const where: Prisma.TransferOutcomeWhereInput = {
        recordedAt: {
          gte: new Date(selection.timeRange.start),
          lte: new Date(selection.timeRange.end),
        },
      };
      if (selection.anchorSlugs?.length) {
        const anchorIds = await db.anchor.findMany({
          where: { slug: { in: [...selection.anchorSlugs] } },
          select: { id: true },
        });
        if (anchorIds.length > 0) {
          where.anchorId = { in: anchorIds.map((a) => a.id) };
        }
      }
      if (selection.corridorSlugs?.length) {
        const corridorIds = await db.corridor.findMany({
          where: { slug: { in: [...selection.corridorSlugs] } },
          select: { id: true },
        });
        if (corridorIds.length > 0) {
          where.corridorId = { in: corridorIds.map((c) => c.id) };
        }
      }

      const outcomes = await db.transferOutcome.findMany({
        where,
        orderBy: [{ anchorId: "asc" }, { corridorId: "asc" }, { recordedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          anchor: { select: { slug: true } },
          corridor: { select: { slug: true } },
          status: true,
          fillRate: true,
          settlementMs: true,
          slippage: true,
          recordedAt: true,
        },
      });

      for (const o of outcomes) {
        yield {
          id: o.id,
          anchorSlug: o.anchor.slug,
          corridorSlug: o.corridor.slug,
          status: o.status,
          fillRate: o.fillRate,
          settlementMs: o.settlementMs,
          slippage: o.slippage,
          recordedAt: o.recordedAt.toISOString(),
        };
      }
    },

    async queryReputationScores(selection) {
      const where: Prisma.ReputationScoreWhereInput = {};
      if (selection.anchorSlugs?.length) {
        const anchorIds = await db.anchor.findMany({
          where: { slug: { in: [...selection.anchorSlugs] } },
          select: { id: true },
        });
        if (anchorIds.length > 0) {
          where.anchorId = { in: anchorIds.map((a) => a.id) };
        }
      }

      const scores = await db.reputationScore.findMany({
        where,
        orderBy: { anchorId: "asc" },
        select: {
          id: true,
          anchor: { select: { slug: true } },
          compositeScore: true,
          scoreBand: true,
          fillRate7d: true,
          fillRate30d: true,
          fillRate90d: true,
          settleP50Ms: true,
          settleP95Ms: true,
          slippageP50: true,
          slippageP95: true,
          sampleSize: true,
          state: true,
          computedAt: true,
        },
      });

      return scores.map((s) => ({
        id: s.id,
        anchorSlug: s.anchor.slug,
        compositeScore: s.compositeScore,
        scoreBand: s.scoreBand,
        fillRate7d: s.fillRate7d,
        fillRate30d: s.fillRate30d,
        fillRate90d: s.fillRate90d,
        settleP50Ms: s.settleP50Ms,
        settleP95Ms: s.settleP95Ms,
        slippageP50: s.slippageP50,
        slippageP95: s.slippageP95,
        sampleSize: s.sampleSize,
        state: s.state,
        computedAt: s.computedAt.toISOString(),
      }));
    },
  });
}