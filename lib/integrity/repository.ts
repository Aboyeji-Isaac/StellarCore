import { getDbForWorkload, MAINTENANCE_WORKLOAD } from "@/lib/db/workloadAccessor";
import type {
  EvidenceIntegrityAuditDependencies,
  EvidenceIntegrityAuditLimits,
  EvidenceIntegrityAuditReadResult,
  EvidenceIntegrityAuditSnapshot,
} from "@/types/integrity";

/**
 * Read-only Prisma reader for the persisted evidence graph. It only issues
 * `findMany` selects — it never writes, updates, deletes, or opens a
 * transaction. High-volume tables are bounded so the audit cannot load an
 * unbounded amount of history.
 */
export const PRISMA_EVIDENCE_INTEGRITY_REPOSITORY: EvidenceIntegrityAuditDependencies =
  Object.freeze({
    async readSnapshot(
      limits: EvidenceIntegrityAuditLimits,
    ): Promise<EvidenceIntegrityAuditReadResult> {
      const db = getDbForWorkload(MAINTENANCE_WORKLOAD);
      const take = limits.maxRowsPerHighVolumeTable + 1;

      const [
        anchors,
        corridors,
        anchorCorridors,
        rateSnapshotRows,
        transferOutcomeRows,
        reputationScoreRows,
      ] = await Promise.all([
        db.anchor.findMany({
          orderBy: { id: "asc" },
          select: { id: true, slug: true, status: true, createdAt: true },
        }),
        db.corridor.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            slug: true,
            assetCodeFrom: true,
            countryFrom: true,
            assetCodeTo: true,
            countryTo: true,
          },
        }),
        db.anchorCorridor.findMany({
          orderBy: [{ anchorId: "asc" }, { corridorId: "asc" }],
          select: { anchorId: true, corridorId: true },
        }),
        db.rateSnapshot.findMany({
          take,
          orderBy: [{ capturedAt: "desc" }, { id: "asc" }],
          select: {
            id: true,
            anchorId: true,
            corridorId: true,
            rate: true,
            sourceAmount: true,
            destinationAmount: true,
            fee: true,
            capturedAt: true,
          },
        }),
        db.transferOutcome.findMany({
          take,
          orderBy: [{ recordedAt: "desc" }, { id: "asc" }],
          select: {
            id: true,
            anchorId: true,
            corridorId: true,
            status: true,
            fillRate: true,
            settlementMs: true,
            slippage: true,
            recordedAt: true,
          },
        }),
        db.reputationScore.findMany({
          orderBy: { id: "asc" },
          select: {
            id: true,
            anchorId: true,
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
        }),
      ]);

      const rateSnapshotsTruncated =
        rateSnapshotRows.length > limits.maxRowsPerHighVolumeTable;
      const transferOutcomesTruncated =
        transferOutcomeRows.length > limits.maxRowsPerHighVolumeTable;

      const snapshot: EvidenceIntegrityAuditSnapshot = Object.freeze({
        anchors: Object.freeze(anchors.map((anchor) => Object.freeze({
          id: anchor.id,
          slug: anchor.slug,
          status: anchor.status,
          createdAt: new Date(anchor.createdAt.getTime()),
        }))),
        corridors: Object.freeze(corridors.map((corridor) => Object.freeze({
          id: corridor.id,
          slug: corridor.slug,
          assetCodeFrom: corridor.assetCodeFrom,
          countryFrom: corridor.countryFrom,
          assetCodeTo: corridor.assetCodeTo,
          countryTo: corridor.countryTo,
        }))),
        anchorCorridors: Object.freeze(anchorCorridors.map((membership) =>
          Object.freeze({
            anchorId: membership.anchorId,
            corridorId: membership.corridorId,
          }))),
        rateSnapshots: Object.freeze(
          rateSnapshotRows.slice(0, limits.maxRowsPerHighVolumeTable).map((row) =>
            Object.freeze({
              id: row.id,
              anchorId: row.anchorId,
              corridorId: row.corridorId,
              rate: row.rate.toString(),
              sourceAmount: row.sourceAmount.toString(),
              destinationAmount: row.destinationAmount.toString(),
              fee: row.fee.toString(),
              capturedAt: new Date(row.capturedAt.getTime()),
            })),
        ),
        transferOutcomes: Object.freeze(
          transferOutcomeRows
            .slice(0, limits.maxRowsPerHighVolumeTable)
            .map((row) => Object.freeze({
              id: row.id,
              anchorId: row.anchorId,
              corridorId: row.corridorId,
              status: row.status,
              fillRate: row.fillRate,
              settlementMs: row.settlementMs,
              slippage: row.slippage,
              recordedAt: new Date(row.recordedAt.getTime()),
            })),
        ),
        reputationScores: Object.freeze(reputationScoreRows.map((row) =>
          Object.freeze({
            id: row.id,
            anchorId: row.anchorId,
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
            computedAt: new Date(row.computedAt.getTime()),
          }))),
      });

      return Object.freeze({
        snapshot,
        truncated: rateSnapshotsTruncated || transferOutcomesTruncated,
      });
    },
  });
