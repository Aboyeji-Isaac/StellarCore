import { getDbForWorkload, PUBLIC_WORKLOAD } from "@/lib/db/workloadAccessor";
import { createHash } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Prisma } from "@/app/generated/prisma/client";
import { canonicalStringify, computeRootHash, sha256 } from "@/lib/export/canonical";
import { assertExportSafe } from "@/lib/export/safety";
import {
  EVIDENCE_EXPORT_VERSION,
  type EvidenceMemberPath,
  type ExportDependencies,
  type ExportManifest,
  type ExportManifestEntry,
  type ExportRegistry,
  type ExportResult,
  type ExportSelection,
} from "@/lib/export/types";

const STELLARCORE_VERSION = "0.1.0";
const PAGE_SIZE = 250;

class InvalidExportSelectionError extends Error {
  constructor() {
    super("INVALID_SELECTION");
    this.name = "InvalidExportSelectionError";
  }
}

export async function exportEvidence(
  dependencies: ExportDependencies,
  selection: ExportSelection,
  outputDir: string,
  exportedBy: string,
  now: () => Date = () => new Date(),
): Promise<ExportResult> {
  try {
    const normalizedSelection = normalizeSelection(selection);
    const normalizedExporter = exportedBy.trim();
    if (!normalizedExporter || normalizedExporter.length > 200) {
      throw new InvalidExportSelectionError();
    }

    await mkdir(outputDir, { recursive: true });

    const registry = await dependencies.queryRegistry(normalizedSelection);
    assertExportSafe(registry);

    const members: ExportManifestEntry[] = [];
    members.push(
      await writeCanonicalJsonMember(
        outputDir,
        "registry.json",
        registry,
        registry.anchors.length +
          registry.corridors.length +
          registry.anchorCorridors.length,
      ),
    );
    members.push(
      await writeNdjsonMember(
        outputDir,
        "rate-snapshots.ndjson",
        dependencies.streamRateSnapshots(normalizedSelection),
      ),
    );
    members.push(
      await writeNdjsonMember(
        outputDir,
        "transfer-outcomes.ndjson",
        dependencies.streamTransferOutcomes(normalizedSelection),
      ),
    );
    members.push(
      await writeNdjsonMember(
        outputDir,
        "reputation-scores.ndjson",
        dependencies.streamReputationScores(normalizedSelection),
      ),
    );

    const sortedMembers = Object.freeze(
      [...members].sort((a, b) => a.path.localeCompare(b.path)),
    );

    const provenance = Object.freeze({
      exportedAt: now().toISOString(),
      exportedBy: normalizedExporter,
      stellarCoreVersion: STELLARCORE_VERSION,
      schemaVersion: EVIDENCE_EXPORT_VERSION,
      selection: normalizedSelection,
      ...(process.env.STELLARCORE_DEPLOYMENT_REVISION?.trim()
        ? { deploymentRevision: process.env.STELLARCORE_DEPLOYMENT_REVISION.trim() }
        : {}),
      ...(process.env.STELLARCORE_CONFIG_FINGERPRINT?.trim()
        ? {
            configurationFingerprint:
              process.env.STELLARCORE_CONFIG_FINGERPRINT.trim().toLowerCase(),
          }
        : {}),
    });

    assertExportSafe(provenance);

    const manifest: ExportManifest = Object.freeze({
      version: EVIDENCE_EXPORT_VERSION,
      provenance,
      members: sortedMembers,
      rootSha256: computeRootHash(sortedMembers, provenance),
    });

    await writeFile(
      join(outputDir, "manifest.json"),
      canonicalStringify(manifest) + "\n",
      "utf8",
    );

    return Object.freeze({
      ok: true,
      outputPath: outputDir,
      manifest,
    });
  } catch (error) {
    if (error instanceof InvalidExportSelectionError) {
      return exportFailure(
        "INVALID_SELECTION",
        "Export selection is invalid",
      );
    }
    if (error instanceof Error && error.message.startsWith("SECRET_DETECTED")) {
      return exportFailure(
        "SECRET_DETECTED",
        "Export safety policy rejected sensitive data",
      );
    }
    return exportFailure(
      "IO_ERROR",
      "Evidence export failed",
    );
  }
}

export function createPrismaExportDependencies(): ExportDependencies {
  return Object.freeze({
    async queryRegistry(selection): Promise<ExportRegistry> {
      const db = getDbForWorkload(PUBLIC_WORKLOAD);

      const anchorWhere: Prisma.AnchorWhereInput = {};
      if (selection.anchorSlugs?.length) {
        anchorWhere.slug = { in: [...selection.anchorSlugs] };
      }

      const corridorWhere: Prisma.CorridorWhereInput = {};
      if (selection.corridorSlugs?.length) {
        corridorWhere.slug = { in: [...selection.corridorSlugs] };
      }

      const associationWhere: Prisma.AnchorCorridorWhereInput = {};
      if (selection.anchorSlugs?.length) {
        associationWhere.anchor = {
          slug: { in: [...selection.anchorSlugs] },
        };
      }
      if (selection.corridorSlugs?.length) {
        associationWhere.corridor = {
          slug: { in: [...selection.corridorSlugs] },
        };
      }

      const [anchors, corridors, associations] = await Promise.all([
        db.anchor.findMany({
          where: anchorWhere,
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
        }),
        db.corridor.findMany({
          where: corridorWhere,
          orderBy: { slug: "asc" },
          select: {
            slug: true,
            assetCodeFrom: true,
            countryFrom: true,
            assetCodeTo: true,
            countryTo: true,
          },
        }),
        db.anchorCorridor.findMany({
          where: associationWhere,
          orderBy: [{ anchorId: "asc" }, { corridorId: "asc" }],
          select: {
            anchor: { select: { slug: true } },
            corridor: { select: { slug: true } },
          },
        }),
      ]);

      return Object.freeze({
        anchors: Object.freeze(
          anchors.map((anchor) =>
            Object.freeze({
              ...anchor,
              seps: Object.freeze([...anchor.seps]),
              createdAt: anchor.createdAt.toISOString(),
              updatedAt: anchor.updatedAt.toISOString(),
            }),
          ),
        ),
        corridors: Object.freeze(
          corridors.map((corridor) => Object.freeze({ ...corridor })),
        ),
        anchorCorridors: Object.freeze(
          associations
            .map(({ anchor, corridor }) =>
              Object.freeze({
                anchorSlug: anchor.slug,
                corridorSlug: corridor.slug,
              }),
            )
            .sort(
              (a, b) =>
                a.anchorSlug.localeCompare(b.anchorSlug) ||
                a.corridorSlug.localeCompare(b.corridorSlug),
            ),
        ),
      });
    },

    async *streamRateSnapshots(selection) {
      const db = getDbForWorkload(PUBLIC_WORKLOAD);
      const where: Prisma.RateSnapshotWhereInput = {
        capturedAt: {
          gte: new Date(selection.timeRange.start),
          lte: new Date(selection.timeRange.end),
        },
      };
      if (selection.anchorSlugs?.length) {
        where.anchor = { slug: { in: [...selection.anchorSlugs] } };
      }
      if (selection.corridorSlugs?.length) {
        where.corridor = { slug: { in: [...selection.corridorSlugs] } };
      }

      let cursor: string | undefined;
      for (;;) {
        const rows = await db.rateSnapshot.findMany({
          where,
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
        if (rows.length === 0) break;

        for (const row of rows) {
          yield Object.freeze({
            id: row.id,
            anchorSlug: row.anchor.slug,
            corridorSlug: row.corridor.slug,
            rate: row.rate.toString(),
            sourceAmount: row.sourceAmount.toString(),
            destinationAmount: row.destinationAmount.toString(),
            fee: row.fee.toString(),
            capturedAt: row.capturedAt.toISOString(),
          });
        }

        cursor = rows[rows.length - 1]!.id;
        if (rows.length < PAGE_SIZE) break;
      }
    },

    async *streamTransferOutcomes(selection) {
      const db = getDbForWorkload(PUBLIC_WORKLOAD);
      const where: Prisma.TransferOutcomeWhereInput = {
        recordedAt: {
          gte: new Date(selection.timeRange.start),
          lte: new Date(selection.timeRange.end),
        },
      };
      if (selection.anchorSlugs?.length) {
        where.anchor = { slug: { in: [...selection.anchorSlugs] } };
      }
      if (selection.corridorSlugs?.length) {
        where.corridor = { slug: { in: [...selection.corridorSlugs] } };
      }

      let cursor: string | undefined;
      for (;;) {
        const rows = await db.transferOutcome.findMany({
          where,
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
        if (rows.length === 0) break;

        for (const row of rows) {
          yield Object.freeze({
            id: row.id,
            anchorSlug: row.anchor.slug,
            corridorSlug: row.corridor.slug,
            status: row.status,
            fillRate: row.fillRate,
            settlementMs: row.settlementMs,
            slippage: row.slippage,
            recordedAt: row.recordedAt.toISOString(),
          });
        }

        cursor = rows[rows.length - 1]!.id;
        if (rows.length < PAGE_SIZE) break;
      }
    },

    async *streamReputationScores(selection) {
      const db = getDbForWorkload(PUBLIC_WORKLOAD);
      const where: Prisma.ReputationScoreWhereInput = {
        computedAt: {
          gte: new Date(selection.timeRange.start),
          lte: new Date(selection.timeRange.end),
        },
      };
      if (selection.anchorSlugs?.length) {
        where.anchor = { slug: { in: [...selection.anchorSlugs] } };
      }

      let cursor: string | undefined;
      for (;;) {
        const rows = await db.reputationScore.findMany({
          where,
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
        if (rows.length === 0) break;

        for (const row of rows) {
          yield Object.freeze({
            id: row.id,
            anchorSlug: row.anchor.slug,
            compositeScore: row.compositeScore,
            scoreBand: row.scoreBand,
            fillRate7d: row.fillRate7d,
            fillRate30d: row.fillRate30d,
            fillRate90d: row.fillRate90d,
            settleP50Ms: row.settleP50Ms,
            settleP95Ms: row.settleP95Ms,
            slippageP50: row.slippageP50,
            slippageP95: row.slippageP95,
            sampleSize: row.sampleSize,
            state: row.state,
            computedAt: row.computedAt.toISOString(),
          });
        }

        cursor = rows[rows.length - 1]!.id;
        if (rows.length < PAGE_SIZE) break;
      }
    },
  });
}

function normalizeSelection(selection: ExportSelection): ExportSelection {
  const start = new Date(selection.timeRange.start);
  const end = new Date(selection.timeRange.end);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    throw new InvalidExportSelectionError();
  }

  const anchorSlugs = normalizeSlugs(selection.anchorSlugs);
  const corridorSlugs = normalizeSlugs(selection.corridorSlugs);

  return Object.freeze({
    timeRange: Object.freeze({
      start: start.toISOString(),
      end: end.toISOString(),
    }),
    ...(anchorSlugs ? { anchorSlugs } : {}),
    ...(corridorSlugs ? { corridorSlugs } : {}),
  });
}

function normalizeSlugs(values: readonly string[] | undefined):
  | readonly string[]
  | undefined {
  if (values === undefined) return undefined;
  const normalized = [...new Set(values.map((value) => value.trim()))].sort();
  if (
    normalized.length === 0 ||
    normalized.some(
      (slug) =>
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 120,
    )
  ) {
    throw new InvalidExportSelectionError();
  }
  return Object.freeze(normalized);
}

async function writeCanonicalJsonMember(
  outputDir: string,
  path: EvidenceMemberPath,
  value: unknown,
  recordCount: number,
): Promise<ExportManifestEntry> {
  assertExportSafe(value);
  const data = canonicalStringify(value) + "\n";
  await writeFile(join(outputDir, path), data, "utf8");
  return Object.freeze({
    path,
    sha256: sha256(data),
    byteLength: Buffer.byteLength(data, "utf8"),
    recordCount,
  });
}

async function writeNdjsonMember(
  outputDir: string,
  path: EvidenceMemberPath,
  rows: AsyncIterable<unknown>,
): Promise<ExportManifestEntry> {
  const handle = await open(join(outputDir, path), "w");
  const hash = createHash("sha256");
  let byteLength = 0;
  let recordCount = 0;

  try {
    for await (const row of rows) {
      assertExportSafe(row);
      const line = canonicalStringify(row) + "\n";
      await handle.write(line);
      hash.update(line);
      byteLength += Buffer.byteLength(line, "utf8");
      recordCount += 1;
    }
  } finally {
    await handle.close();
  }

  return Object.freeze({
    path,
    sha256: hash.digest("hex"),
    byteLength,
    recordCount,
  });
}


function exportFailure(
  code: Extract<ExportResult, { ok: false }>["code"],
  message: string,
): ExportResult {
  return Object.freeze({ ok: false as const, code, message });
}
